import { promises as fs } from "node:fs";
import path from "node:path";
import type { Memory } from "./types.js";
import { newMemory } from "./types.js";
import { parseMemoryFile, serializeMemory } from "./frontmatter.js";

// 去掉标点/空白后取相邻字符二元组(shingle):对中文(无词边界)近重复鲁棒,
// 同时对 ASCII 也按字符级比较。纯确定性,无分词依赖。
function shingles(s: string): Set<string> {
  const chars = [...s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")];
  const out = new Set<string>();
  if (chars.length <= 1) { if (chars.length === 1) out.add(chars[0] ?? ""); return out; }
  for (let i = 0; i < chars.length - 1; i++) out.add((chars[i] ?? "") + (chars[i + 1] ?? ""));
  return out;
}
export function textSimilarity(a: string, b: string): number {
  const A = shingles(a), B = shingles(b); if (!A.size && !B.size) return 1;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
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
export async function loadAllMemories(projectDir: string, userDir: string): Promise<Memory[]> {
  const [u, p] = await Promise.all([readDir(userDir), readDir(projectDir)]);
  return [...u, ...p].filter((m) => m.status === "active");
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
