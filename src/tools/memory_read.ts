import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "./types.js";
import { loadAllMemories } from "../memory/store.js";
import type { Memory } from "../memory/types.js";

// 查跨会话记忆:给【名字/标题】或【关键词】,返回相关条目(用户模型/偏好/项目事实/历史决策/技术坑)。
// 跨三层目录读(项目级 / 用户级 ~/.dao/memory / 知识库 ~/.dao/knowledge)——后两层在工作区沙箱外,
// 普通 Read/Grep 够不着,故需本专用工具。纯文件读、零模型、【子串匹配】(不再用相似度)。
// 用法:① 注入的"记忆索引"里看到相关 title → 给它取整句;② 想按词回忆之前定下的事 → 给关键词。
const fmtFull = (m: Memory): string =>
  `[${m.type}·重${m.importance}·命中${m.uses ?? 0}${m.source ? `·来源 ${m.source}` : ""}]\n${m.text}`;

export const memoryReadTool = defineTool({
  name: "MemoryRead",
  description:
    "查跨会话记忆:给名字(slug)或关键词/问题,返回最相关的若干条(用户模型/偏好/项目事实/历史决策/技术坑)。回答关于用户或项目的问题、或需要回忆之前定下的事时用它,别去翻代码。索引里看到相关名字也用它取整句。" +
    "多词查询是【全部命中】(AND,非模糊/OR),查不到就换更短的关键词而非加更多词。查询范围跨三层:项目级" +
    "(这个仓库)、用户级(跨项目,~/.dao/memory)、知识库(跨项目的通用经验,~/.dao/knowledge)——名字精确匹配时" +
    "只返回那一条整句;关键词匹配默认最多返回 6 条,可用 limit 调到最多 20。举例:用户说'按我之前说的偏好来'," +
    "先用它查一下'偏好'相关的记忆,而不是凭这一轮对话里的印象自己猜。多次查不到不代表这类记忆一定不存在," +
    "先换更短更泛的关键词试一两次,再判断确实没有,别一次落空就直接下结论说'没有相关记忆'。",
  descriptionEn:
    "Queries cross-session memories: pass a name (slug) or keyword/question, returns the most relevant entries (user model/preferences/project facts/past decisions/technical pitfalls). Use when answering questions about the user or project, or when recalling previously established facts — don't search code for these. Also use when you see a relevant name in an index to retrieve the full entry. " +
    "Multi-word queries require ALL terms to match (AND, not fuzzy/OR) — if nothing found, try fewer/shorter keywords rather than adding more. Searches across three scopes: " +
    "project-level (this repo), user-level (cross-project, ~/.dao/memory), and knowledge base (cross-project general know-how, ~/.dao/knowledge) — an exact name match returns " +
    "just that one full entry; keyword matches return up to 6 by default, adjustable via limit up to 20. Example: the user says 'do it the way I prefer' — " +
    "query memory for 'preference'-related entries first rather than guessing from impressions within this conversation alone. One empty result doesn't mean the memory " +
    "doesn't exist — try a shorter, broader keyword once or twice before concluding 'no relevant memory found'.",
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
