import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool } from "./types.js";
import { classifyPath } from "./paths.js";

export const listDirTool = defineTool({
  name: "list_dir",
  description: "列出工作区内某个目录的条目,目录名以 / 结尾,按字典序排列。",
  capability: "read",
  approval: "auto",
  schema: z.object({
    path: z.string().optional().describe("相对工作区根目录的目录路径,默认根目录"),
  }),
  handler: async (args, ctx) => {
    const { abs, external } = classifyPath(ctx.workspaceRoot, args.path ?? ".");
    if (external && !(await (ctx.approveExternalRead?.(abs) ?? Promise.resolve(false)))) {
      return `Error: ${args.path} 在工作区之外,未获授权访问(可在弹出的授权中放行)。`;
    }
    const entries = await fs.readdir(abs, { withFileTypes: true });
    if (entries.length === 0) return "(空目录)";
    const sorted = [...entries]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    const MAX = 500; // 超大目录(如 node_modules)截断,防撑爆上下文
    if (sorted.length > MAX) {
      return sorted.slice(0, MAX).join("\n") + `\n…(共 ${sorted.length} 项,已截断前 ${MAX};用 grep_files/file_search 精确定位)`;
    }
    return sorted.join("\n");
  },
});
