import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "./types.js";
import { loadAllMemories, textSimilarity } from "../memory/store.js";

// 按需检索跨会话记忆:启动只注入 top-K,被截断或刚写的记忆模型仍可主动查。
// 回答"关于用户/项目/偏好/历史决策"的问题时,先查这里再说不知道。
export const memorySearchTool = defineTool({
  name: "memory_search",
  description:
    "检索跨会话记忆(用户模型/偏好/项目事实/历史决策)。给关键词或问题,返回最相关的若干条。回答关于用户或项目的问题、或需要回忆之前定下的事时用它,而不是去翻代码。",
  capability: "read",
  approval: "auto",
  schema: z.object({
    query: z.string().min(1).describe("检索关键词或问题"),
    limit: z.number().int().min(1).max(20).optional().describe("返回条数,默认 8"),
  }),
  handler: async (args, ctx) => {
    const projectDir = path.join(ctx.workspaceRoot, ".dao", "memory");
    const userDir = path.join(ctx.homeDir ?? os.homedir(), ".dao", "memory");
    const knowledgeDir = path.join(ctx.homeDir ?? os.homedir(), ".dao", "knowledge");
    const mems = await loadAllMemories(projectDir, userDir, knowledgeDir);
    if (mems.length === 0) return "(暂无记忆)";
    const scored = mems
      .map((m) => ({ m, s: textSimilarity(m.text, args.query) + (m.text.includes(args.query) ? 0.5 : 0) }))
      .filter((x) => x.s > 0.05)
      .sort((a, b) => b.s - a.s)
      .slice(0, args.limit ?? 8);
    if (scored.length === 0) return "(无相关记忆)";
    return scored.map(({ m }) => `- [${m.type}] ${m.text}`).join("\n");
  },
});
