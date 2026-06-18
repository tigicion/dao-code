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

import { textSimilarity } from "../text/similarity.js";
export { textSimilarity }; // 对外导出(memory_read 的关键词匹配从 store 引用)

// ≥DUP_THRESHOLD:确定性自动合并(无 LLM)。
// [GRAY_LOW, DUP_THRESHOLD):灰区——只对最相似的那一条喊 flash 裁判判是否同一事实(每候选至多 1 次)。
// <GRAY_LOW:确定性判为新(不喊 LLM,省钱)。0.2 floor 让无关项(只共享"用户"之类)被跳过。
export const DUP_THRESHOLD = 0.9;
export const GRAY_LOW = 0.2;

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

// 相似度分带去重:≥DUP_THRESHOLD 确定性合并;灰区交 adjudicate(flash 裁判,可选)判;否则写新文件。
// adjudicate 仅对最相似的那一条、且相似度落在 [GRAY_LOW, DUP_THRESHOLD) 时被调用(每次 upsert 至多 1 次)。
export async function upsertMemory(
  dir: string,
  cand: Memory,
  existing: Memory[],
  adjudicate?: (cand: Memory, existing: Memory) => Promise<boolean>,
): Promise<{ action: "added" | "updated"; name: string }> {
  let best: Memory | undefined; let bestS = 0;
  for (const m of existing) {
    if (m.type !== cand.type) continue;
    const s = textSimilarity(m.text, cand.text);
    if (s > bestS) { bestS = s; best = m; }
  }
  if (best && !best.locked) {
    const isDup =
      bestS >= DUP_THRESHOLD ||
      (bestS >= GRAY_LOW && !!adjudicate && (await adjudicate(cand, best)));
    if (isDup) {
      const updated: Memory = { ...best, text: cand.text, lastUsed: cand.lastUsed, importance: Math.max(best.importance, cand.importance), uses: (best.uses ?? 0) + 1 };
      await writeMemory(dir, updated);
      return { action: "updated", name: best.name };
    }
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
