import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "./types.js";
import { loadAllMemories } from "../memory/store.js";

// 按名读取一条记忆的整句全文。配合【记忆索引】用:索引里只给 slug 名,看到相关的就用本工具取整句细节。
// 纯文件读取,不调任何模型(更不调 flash)——相关性判断由主模型在常驻索引上自己做(缓存热、免费)。
export const memoryReadTool = defineTool({
  name: "memory_read",
  description:
    "按名字读取一条记忆的整句全文。配合记忆索引用:索引里看到相关的名字(slug),用它取回那条记忆的完整内容。纯读取,不搜索——要按关键词找用 memory_search。",
  capability: "read",
  approval: "auto",
  schema: z.object({
    name: z.string().min(1).describe("记忆名(索引里的 slug);也接受部分匹配"),
  }),
  handler: async (args, ctx) => {
    const projectDir = path.join(ctx.workspaceRoot, ".dao", "memory");
    const userDir = path.join(ctx.homeDir ?? os.homedir(), ".dao", "memory");
    const knowledgeDir = path.join(ctx.homeDir ?? os.homedir(), ".dao", "knowledge");
    const mems = await loadAllMemories(projectDir, userDir, knowledgeDir);
    const q = args.name.trim();
    const exact = mems.find((m) => m.name === q);
    const m = exact ?? mems.find((x) => x.name.includes(q) || q.includes(x.name));
    if (!m) return `(未找到记忆:${q})`;
    const meta = `[${m.type}·重${m.importance}·命中${m.uses ?? 0}${m.source ? `·来源 ${m.source}` : ""}]`;
    return `${meta}\n${m.text}`;
  },
});
