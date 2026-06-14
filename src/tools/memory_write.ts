import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool } from "./types.js";
import { loadAllMemories, upsertMemory, routeScope } from "../memory/store.js";
import { newMemory } from "../memory/types.js";
import { contentHash } from "../memory/hash.js";
import { findSecrets } from "../permissions/secrets.js";
import { resolveInWorkspace } from "./paths.js";

const memDir = (scope: "project" | "user" | "knowledge", ws: string, home?: string) => {
  if (scope === "knowledge") return path.join(home ?? os.homedir(), ".dao", "knowledge");
  return path.join(scope === "user" ? home ?? os.homedir() : ws, ".dao", "memory");
};

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
    "记录一条跨 session 的稳定记忆。最高价值是【用户模型】:用户信息(环境/技术栈/水平/习惯)、偏好、意图,以及你推断出的、用户没明说的信息/意图(这类把 confidence 设低、type=user)。用户纠正你的做法或确认某个非显然做法可行时,记 type=feedback:正文先写规则,再接'为什么:…'和'怎么用:…'。也可记通用规则(procedural)、项目事实(semantic)与项目进展(episodic)。只记耐久且可泛化的,克制使用。若该事实是从某个文件/代码推导出来的,务必填 source(如 'package.json#packageManager'),以便日后对照实时文件验证是否过期。",
  capability: "plan",
  approval: "auto",
  schema: z.object({
    text: z.string().min(1).describe("要记住的事实(一句话)"),
    type: z.enum(["user", "feedback", "semantic", "procedural", "episodic"]).optional().describe("user=用户模型,feedback=用户对工作方式的指导(默认 semantic)"),
    importance: z.number().int().min(1).max(10).optional().describe("1–10 重要度,默认 5"),
    confidence: z.number().min(0).max(1).optional().describe("用户模型/推断类填,0–1"),
    source: z.string().optional().describe("该事实的代码出处 path 或 path#symbol"),
    scope: z.enum(["project", "user", "knowledge"]).optional().describe("不填按类型定:procedural→knowledge(跨项目知识库),user/feedback→user,其余→project"),
  }),
  handler: async (args, ctx) => {
    // S5.1:密钥绝不写进持久记忆。命中即拒(不落盘),让模型改记不含密钥的描述。
    const secrets = findSecrets(args.text);
    if (secrets.length) return `拒绝写入记忆:疑似含密钥(${secrets.join("、")})。请勿把凭据写进记忆;如需记录,改写成不含密钥的描述。`;
    // 显式 scope 优先;否则本地优先路由(没把握的进项目级)。
    const scope = args.scope ?? routeScope(args.type ?? "semantic", args.confidence);
    const dir = memDir(scope, ctx.workspaceRoot, ctx.homeDir);
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
      const existing = await loadAllMemories(
        memDir("project", ctx.workspaceRoot, ctx.homeDir),
        memDir("user", ctx.workspaceRoot, ctx.homeDir),
        memDir("knowledge", ctx.workspaceRoot, ctx.homeDir),
      );
      return upsertMemory(dir, cand, existing);
    });
    const label = scope === "user" ? "用户级" : scope === "knowledge" ? "知识库" : "项目级";
    return r.action === "updated"
      ? `已更新(${label}):${args.text.trim()}`
      : `已记住(${label}):${args.text.trim()}`;
  },
});
