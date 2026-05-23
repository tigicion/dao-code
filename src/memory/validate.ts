import { promises as fs } from "node:fs";
import type { Memory } from "./types.js";
import { resolveInWorkspace } from "../tools/paths.js";
import { contentHash } from "./hash.js";

export type Verdict = "ok" | "changed" | "stale";
export interface Validation { verdict: Verdict; }

export async function validateMemory(m: Memory, workspaceRoot: string, today: string): Promise<Validation> {
  if (m.validUntil && m.validUntil < today) return { verdict: "stale" };
  if (!m.source) return { verdict: "ok" };
  const rel = m.source.split("#")[0] ?? m.source;
  let file: string;
  try { file = resolveInWorkspace(workspaceRoot, rel); } catch { return { verdict: "ok" }; } // 越界 source 不验证,放行
  let content: string;
  try { content = await fs.readFile(file, "utf8"); } catch { return { verdict: "stale" }; }
  if (m.sourceHash && contentHash(content) !== m.sourceHash) return { verdict: "changed" };
  return { verdict: "ok" };
}
