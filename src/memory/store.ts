import { promises as fs } from "node:fs";
import path from "node:path";
import type { Memory, MemoryType } from "./types.js";
import { newMemory } from "./types.js";

// 记忆落到哪一层 = 信息的【作用域】,由 type 决定,【与 confidence 无关】——
// confidence 改喂 GC 的 provisional 耐久门(没把握又没被重确认的,过宽限期快剪),不再决定存哪层。
//   procedural(跨项目通用)→ 知识库;user/feedback(关于用户)→ 用户级;semantic/episodic(本项目)→ 项目级。
export type Scope = "project" | "user" | "knowledge";
export function routeScope(type: MemoryType): Scope {
  if (type === "procedural") return "knowledge";
  if (type === "user" || type === "feedback") return "user";
  return "project";
}
import { parseMemoryFile, serializeMemory } from "./frontmatter.js";

// 文件名/ id 派生:title(或退化用 text)→ slug。记忆去重与 memory_write 共用。
export function slug(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "mem";
}

// 项目 id:工作区目录名的 slug。knowledge 层记忆按此打 origin 标签、并按此过滤注入,
// 使 A 项目学到的领域知识(如 iOS)不再泄进 B 项目会话(见 memory-effectiveness-eval-baseline)。
export function projectIdOf(workspaceRoot: string): string {
  return slug(path.basename(workspaceRoot));
}

// knowledge 层注入过滤:只留【本项目学到的】(origin 命中)或【手动 locked 钉住的(视为通用)】。
// 无 origin 的历史条目 = 来源项目未知 → 不自动注入(仍可被 memory_read 按名取)。
// project/user 层不过滤:project 本就按工作区目录隔离,user 本就该全局。
export function keepKnowledgeForProject<T extends { origin?: string; locked?: boolean }>(
  m: T,
  projectId: string,
): boolean {
  return m.locked === true || (!!m.origin && m.origin === projectId);
}

async function readDir(dir: string): Promise<Memory[]> {
  let names: string[]; try { names = await fs.readdir(dir); } catch { return []; }
  const out: Memory[] = [];
  for (const f of names) {
    if (!f.endsWith(".md")) continue;
    const raw = await fs.readFile(path.join(dir, f), "utf8").catch(() => "");
    const m = parseMemoryFile(f.slice(0, -3), raw);
    if (m) out.push(m);
  }
  return out;
}

// user 在前,只返回 active。
// 从任意多个目录加载并合并(项目级 / 用户级 / 知识库)。去重/注入会各自再排序,合并顺序不影响结果。
export async function loadAllMemories(...dirs: string[]): Promise<Memory[]> {
  const lists = await Promise.all(dirs.map((d) => readDir(d)));
  return lists.flat().filter((m) => m.status === "active");
}

export async function writeMemory(dir: string, m: Memory): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${m.name}.md`), serializeMemory(m), "utf8");
}

// 去重键:有 title 用 slug(title)(标题就是身份),否则退化用 name。
// 关键:mergeInto 的更新分支只改 title 不改 name(=文件名),会让一条记忆的 title 漂移成与另一条相同
// 却各存一份 → 纯按 name 去重永远撞不上。改按 title 键去重,同 title 即同一条。
export function dedupKey(m: { name: string; title?: string }): string {
  return m.title && m.title.trim() ? slug(m.title) : m.name;
}

// 删除 dir 内与 keepName 同去重键的其它 *.md(历史 title 漂移留下的并行残片)。best-effort,失败不抛。
async function pruneDuplicateFiles(dir: string, key: string, keepName: string): Promise<void> {
  let names: string[]; try { names = await fs.readdir(dir); } catch { return; }
  for (const f of names) {
    if (!f.endsWith(".md")) continue;
    const name = f.slice(0, -3);
    if (name === keepName) continue;
    const raw = await fs.readFile(path.join(dir, f), "utf8").catch(() => "");
    const m = parseMemoryFile(name, raw);
    if (!m || m.locked) continue;
    if (dedupKey(m) === key) await fs.rm(path.join(dir, f), { force: true }).catch(() => {});
  }
}

// 键去重:同 title(或同 name)即同一条 → 覆盖更新(text/title 取新、importance 取大、uses+1),并收敛同键残片。
// 不做字符相似度模糊匹配;【语义合并】(相关但不同 title)交反思器的 mergeInto 处理。
export async function upsertMemory(
  dir: string,
  cand: Memory,
  existing: Memory[],
): Promise<{ action: "added" | "updated"; name: string }> {
  const candKey = dedupKey(cand);
  const match = existing.find((m) => !m.locked && (m.name === cand.name || dedupKey(m) === candKey));
  if (match) {
    const updated: Memory = {
      ...match,
      ...(cand.title ? { title: cand.title } : {}),
      text: cand.text,
      lastUsed: cand.lastUsed,
      importance: Math.max(match.importance, cand.importance),
      uses: (match.uses ?? 0) + 1,
    };
    await writeMemory(dir, updated);
    await pruneDuplicateFiles(dir, dedupKey(updated), updated.name);
    return { action: "updated", name: match.name };
  }
  await writeMemory(dir, cand);
  return { action: "added", name: cand.name };
}

// 真删除:跨给定 dirs 删掉【name 命中】或【slug(title) 命中】的 *.md(locked 跳过)。返回删掉的 name[]。
// 给模型一个真正移除记忆的手段——否则它只能写"已删除"墓碑(status 仍 active,赖着不走)。
export async function deleteMemory(dirs: string[], keyRaw: string): Promise<string[]> {
  const k = slug(keyRaw);
  const removed: string[] = [];
  for (const dir of dirs) {
    let names: string[]; try { names = await fs.readdir(dir); } catch { continue; }
    for (const f of names) {
      if (!f.endsWith(".md")) continue;
      const name = f.slice(0, -3);
      const raw = await fs.readFile(path.join(dir, f), "utf8").catch(() => "");
      const m = parseMemoryFile(name, raw);
      if (!m || m.locked) continue;
      if (name === keyRaw || name === k || (m.title && slug(m.title) === k)) {
        await fs.rm(path.join(dir, f), { force: true }).catch(() => {});
        removed.push(name);
      }
    }
  }
  return removed;
}

// 被验证使用 → 续命:只把 lastUsed 刷到 today,其它字段不动。文件不存在/坏 → false。
export async function touchMemory(dir: string, name: string, today: string): Promise<boolean> {
  const raw = await fs.readFile(path.join(dir, `${name}.md`), "utf8").catch(() => "");
  const m = parseMemoryFile(name, raw);
  if (!m) return false;
  await writeMemory(dir, { ...m, lastUsed: today });
  return true;
}

export async function supersedeMemory(dir: string, oldName: string, newName: string, validUntil: string): Promise<void> {
  const raw = await fs.readFile(path.join(dir, `${oldName}.md`), "utf8").catch(() => "");
  const m = parseMemoryFile(oldName, raw); if (!m) return;
  await writeMemory(dir, { ...m, status: "superseded", supersededBy: newName, validUntil });
}

// 旧 JSON 迁移成 md。
export async function migrateLegacy(dir: string, today: string): Promise<void> {
  const legacy = path.join(dir, "memories.json");
  let raw: string; try { raw = await fs.readFile(legacy, "utf8"); } catch { return; }
  let arr: unknown; try { arr = JSON.parse(raw); } catch { return; }
  if (!Array.isArray(arr)) return;
  let i = 0;
  for (const item of arr) {
    const text = item && typeof item.text === "string" ? item.text.trim() : "";
    if (!text) continue;
    const name = (text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "mem") + "-" + i++;
    await writeMemory(dir, newMemory({ name, text, type: "semantic", today }));
  }
  await fs.rename(legacy, legacy + ".migrated").catch(() => {});
}
