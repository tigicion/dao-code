import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool } from "./types.js";
import { loadAllMemories, upsertMemory, deleteMemory, routeScope, slug } from "../memory/store.js";
import { newMemory } from "../memory/types.js";
import { contentHash } from "../memory/hash.js";
import { findSecrets } from "../permissions/secrets.js";
import { resolveInWorkspace } from "./paths.js";

const memDir = (scope: "project" | "user" | "knowledge", ws: string, home?: string) => {
  if (scope === "knowledge") return path.join(home ?? os.homedir(), ".dao", "knowledge");
  return path.join(scope === "user" ? home ?? os.homedir() : ws, ".dao", "memory");
};

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
    text: z.string().optional().describe("要记住的事实(完整一句;feedback 带'为什么/怎么用')。delete 时可省。"),
    title: z.string().optional().describe("≤1 行概要(索引展示 + 文件名);不填则用 text 派生。delete 时用它定位要删的记忆。"),
    type: z.enum(["user", "feedback", "semantic", "procedural", "episodic"]).optional().describe("user=用户模型,feedback=用户对工作方式的指导(默认 semantic)"),
    importance: z.number().int().min(1).max(10).optional().describe("1–10 重要度,默认 5"),
    confidence: z.number().min(0).max(1).optional().describe("用户模型/推断类填,0–1"),
    source: z.string().optional().describe("该事实的代码出处 path 或 path#symbol"),
    scope: z.enum(["project", "user", "knowledge"]).optional().describe("不填按类型定:procedural→knowledge(跨项目知识库),user/feedback→user,其余→project"),
    delete: z.boolean().optional().describe("true=删除一条已有记忆(按 title 或 name 定位,真删文件),而非写入。删除时只需给 title/text 之一。"),
  }),
  handler: async (args, ctx) => {
    // 删除路径:真删文件(不写"已删除"墓碑)。按 title 或 text 定位,跨三个作用域查找。
    if (args.delete) {
      const key = (args.title || args.text || "").trim();
      if (!key) return "删除失败:需提供 title 或 text 来定位要删除的记忆。";
      const removed = await withMemLock(() =>
        deleteMemory(
          [
            memDir("project", ctx.workspaceRoot, ctx.homeDir),
            memDir("user", ctx.workspaceRoot, ctx.homeDir),
            memDir("knowledge", ctx.workspaceRoot, ctx.homeDir),
          ],
          key,
        ),
      );
      return removed.length ? `已删除记忆(共 ${removed.length} 条):${removed.join("、")}` : `未找到匹配记忆:${key}`;
    }
    if (!args.text || !args.text.trim()) return "写入失败:text 必填(删除请用 delete: true)。";
    // S5.1:密钥绝不写进持久记忆。命中即拒(不落盘),让模型改记不含密钥的描述。
    const secrets = findSecrets(args.text);
    if (secrets.length) return `拒绝写入记忆:疑似含密钥(${secrets.join("、")})。请勿把凭据写进记忆;如需记录,改写成不含密钥的描述。`;
    // 显式 scope 优先;否则按 type 的作用域路由(与 confidence 无关)。
    const scope = args.scope ?? routeScope(args.type ?? "semantic");
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
      name: slug(args.title || args.text), title: args.title, text: args.text, type: args.type ?? "semantic", today,
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
    ctx.memoryAudit?.wrote(cand.type, r.action === "updated"); // 审计:新建 vs 合并近重复
    const label = scope === "user" ? "用户级" : scope === "knowledge" ? "知识库" : "项目级";
    return r.action === "updated"
      ? `已更新(${label}):${args.text.trim()}`
      : `已记住(${label}):${args.text.trim()}`;
  },
});
