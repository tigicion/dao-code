import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool } from "./types.js";
import { loadAllMemories, upsertMemory } from "../memory/store.js";
import { newMemory } from "../memory/types.js";
import { contentHash } from "../memory/hash.js";
import { resolveInWorkspace } from "./paths.js";

const memDir = (scope: "project" | "user", ws: string) =>
  path.join(scope === "user" ? os.homedir() : ws, ".codeds", "memory");

function slug(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "mem";
}

// 串行锁:并发 memory_write 的"读全部→合并→写回"必须串行,否则后写覆盖先写丢记忆。
let memLock: Promise<unknown> = Promise.resolve();
function withMemLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = memLock.then(fn, fn);
  memLock = run.catch(() => {});
  return run;
}

export const memoryWriteTool = defineTool({
  name: "memory_write",
  description:
    "记录一条跨 session 的稳定记忆。最高价值是【用户模型】:用户信息(环境/技术栈/水平/习惯)、偏好、意图,以及你推断出的、用户没明说的信息/意图(这类把 confidence 设低、type=user)。也可记通用规则(procedural)与项目事实(semantic)。只记耐久且可泛化的,克制使用。若该事实是从某个文件/代码推导出来的,务必填 source(如 'package.json#packageManager'),以便日后对照实时文件验证是否过期。",
  capability: "plan",
  approval: "auto",
  schema: z.object({
    text: z.string().min(1).describe("要记住的事实(一句话)"),
    type: z.enum(["user", "semantic", "procedural", "episodic"]).optional().describe("user=用户模型(默认 semantic)"),
    importance: z.number().int().min(1).max(10).optional().describe("1–10 重要度,默认 5"),
    confidence: z.number().min(0).max(1).optional().describe("用户模型/推断类填,0–1"),
    source: z.string().optional().describe("该事实的代码出处 path 或 path#symbol"),
    scope: z.enum(["project", "user"]).optional().describe("project(默认)或 user"),
  }),
  handler: async (args, ctx) => {
    const scope = args.scope ?? "project";
    const dir = memDir(scope, ctx.workspaceRoot);
    const today = ctx.today ?? new Date().toISOString().slice(0, 10);
    let sourceHash: string | undefined;
    if (args.source) {
      try {
        const rel = args.source.split("#")[0] ?? args.source;
        const f = resolveInWorkspace(ctx.workspaceRoot, rel);
        sourceHash = contentHash(await fs.readFile(f, "utf8"));
      } catch { /* 读不到就只记 source、不记 hash */ }
    }
    const cand = newMemory({
      name: slug(args.text), text: args.text, type: args.type ?? "semantic", today,
      importance: args.importance, confidence: args.confidence, source: args.source, sourceHash,
    });
    const r = await withMemLock(async () => {
      const existing = await loadAllMemories(dir, memDir("user", ctx.workspaceRoot));
      return upsertMemory(dir, cand, existing);
    });
    const label = scope === "user" ? "用户级" : "项目级";
    return r.action === "updated"
      ? `已更新(${label}):${args.text.trim()}`
      : `已记住(${label}):${args.text.trim()}`;
  },
});
