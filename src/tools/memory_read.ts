import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "./types.js";
import { loadAllMemories, textSimilarity } from "../memory/store.js";
import type { Memory } from "../memory/types.js";

// 查跨会话记忆:给【名字(slug)】或【关键词/问题】,返回最相关的若干条(用户模型/偏好/项目事实/历史决策/技术坑)。
// 跨三层目录读(项目级 / 用户级 ~/.dao/memory / 知识库 ~/.dao/knowledge)——后两层在工作区沙箱外,
// 普通 read_file/grep_files 够不着,故需本专用工具。纯文件读、零模型。
// 用法:① 注入的"记忆索引"里看到相关名字 → 给那个名字取整句;② 想按词回忆之前定下的事 → 给关键词。
const fmtFull = (m: Memory): string =>
  `[${m.type}·重${m.importance}·命中${m.uses ?? 0}${m.source ? `·来源 ${m.source}` : ""}]\n${m.text}`;

export const memoryReadTool = defineTool({
  name: "memory_read",
  description:
    "查跨会话记忆:给名字(slug)或关键词/问题,返回最相关的若干条(用户模型/偏好/项目事实/历史决策/技术坑)。回答关于用户或项目的问题、或需要回忆之前定下的事时用它,别去翻代码。索引里看到相关名字也用它取整句。",
  capability: "read",
  approval: "auto",
  schema: z.object({
    query: z.string().min(1).describe("记忆名(slug)或关键词/问题;支持部分匹配"),
    limit: z.number().int().min(1).max(20).optional().describe("返回条数,默认 6"),
  }),
  handler: async (args, ctx) => {
    const projectDir = path.join(ctx.workspaceRoot, ".dao", "memory");
    const userDir = path.join(ctx.homeDir ?? os.homedir(), ".dao", "memory");
    const knowledgeDir = path.join(ctx.homeDir ?? os.homedir(), ".dao", "knowledge");
    const mems = await loadAllMemories(projectDir, userDir, knowledgeDir);
    if (mems.length === 0) return "(暂无记忆)";
    const q = args.query.trim();
    // 精确名命中 → 只回那一条整句全文(配合索引的"按名取"用法)。
    const exact = mems.find((m) => m.name === q);
    if (exact) return fmtFull(exact);
    // 否则按【名字 + 正文】模糊匹配,返回 top-K(吸收原 memory_search 的关键词检索)。
    const scored = mems
      .map((m) => ({
        m,
        s: Math.max(textSimilarity(m.text, q), textSimilarity(m.name, q)) + (m.text.includes(q) || m.name.includes(q) ? 0.5 : 0),
      }))
      .filter((x) => x.s > 0.05)
      .sort((a, b) => b.s - a.s)
      .slice(0, args.limit ?? 6);
    if (scored.length === 0) return `(未找到记忆:${q})`;
    // 单条命中给全文;多条给精简列表(dao 记忆本就一句话)。
    return scored.length === 1 ? fmtFull(scored[0]!.m) : scored.map(({ m }) => `- [${m.type}·重${m.importance}] ${m.text}`).join("\n");
  },
});
