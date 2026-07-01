import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "./types.js";
import { loadAllMemories } from "../memory/store.js";
import type { Memory } from "../memory/types.js";

// 查跨会话记忆:给【名字/标题】或【关键词】,返回相关条目(用户模型/偏好/项目事实/历史决策/技术坑)。
// 跨三层目录读(项目级 / 用户级 ~/.dao/memory / 知识库 ~/.dao/knowledge)——后两层在工作区沙箱外,
// 普通 read_file/grep_files 够不着,故需本专用工具。纯文件读、零模型、【子串匹配】(不再用相似度)。
// 用法:① 注入的"记忆索引"里看到相关 title → 给它取整句;② 想按词回忆之前定下的事 → 给关键词。
const fmtFull = (m: Memory): string =>
  `[${m.type}·重${m.importance}·命中${m.uses ?? 0}${m.source ? `·来源 ${m.source}` : ""}]\n${m.text}`;

export const memoryReadTool = defineTool({
  name: "memory_read",
  description:
    "查跨会话记忆:给名字(slug)或关键词/问题,返回最相关的若干条(用户模型/偏好/项目事实/历史决策/技术坑)。回答关于用户或项目的问题、或需要回忆之前定下的事时用它,别去翻代码。索引里看到相关名字也用它取整句。",
  descriptionEn:
    "Queries cross-session memories: pass a name (slug) or keyword/question, returns the most relevant entries (user model/preferences/project facts/past decisions/technical pitfalls). Use when answering questions about the user or project, or when recalling previously established facts — don't search code for these. Also use when you see a relevant name in an index to retrieve the full entry.",
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
    // 精确命中(名/标题)→ 只回那一条整句全文(配合索引的"按 title 取"用法)。
    const exact = mems.find((m) => m.name === q || m.title === q);
    if (exact) return fmtFull(exact);
    // 否则【关键词 AND 匹配】:查询按空白拆词,某条的 名+标题+正文 含【全部】词才算命中(大小写无关)。
    // 比纯子串能处理"立体声 crash"这类不连续多词查询;仍是确定性、零模型。
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = (m: Memory) => `${m.name} ${m.title ?? ""} ${m.text}`.toLowerCase();
    const hits = mems
      .filter((m) => { const h = hay(m); return terms.every((t) => h.includes(t)); })
      .slice(0, args.limit ?? 6);
    if (hits.length === 0) return `(未找到记忆:${q})`;
    // 单条给全文;多条给精简列表(展示 title,无则正文)。
    return hits.length === 1 ? fmtFull(hits[0]!) : hits.map((m) => `- [${m.type}·重${m.importance}] ${m.title ?? m.text}`).join("\n");
  },
});
