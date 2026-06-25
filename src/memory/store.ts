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

// 精确键去重:name(=slug(title))即唯一键,同名即同一条 → 覆盖更新(text/title 取新、importance 取大、uses+1)。
// 不再做字符相似度模糊匹配;【语义合并】(相关但不同名)交反思器的 mergeInto 处理。
export async function upsertMemory(
  dir: string,
  cand: Memory,
  existing: Memory[],
): Promise<{ action: "added" | "updated"; name: string }> {
  const match = existing.find((m) => m.name === cand.name && !m.locked);
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
    return { action: "updated", name: match.name };
  }
  await writeMemory(dir, cand);
  return { action: "added", name: cand.name };
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
