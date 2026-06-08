import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool } from "./types.js";
import { classifyPath } from "./paths.js";
import { walkFiles } from "./walk.js";
import { globToRegExp } from "./glob.js";

const MAX = 100;

export const fileSearchTool = defineTool({
  name: "file_search",
  description: "在工作区内按文件名/路径 glob 搜索文件(如 *.ts 或 **/*.test.ts),按修改时间从新到旧排序。",
  capability: "read",
  approval: "auto",
  schema: z.object({
    glob: z.string().describe("文件名/路径 glob"),
    path: z.string().optional().describe("搜索子目录,默认工作区根"),
  }),
  handler: async (args, ctx) => {
    const { abs: root, external } = classifyPath(ctx.workspaceRoot, args.path ?? ".");
    if (external && !(await (ctx.approveExternalRead?.(root) ?? Promise.resolve(false)))) {
      return `Error: ${args.path} 在工作区之外,未获授权访问(可在弹出的授权中放行)。`;
    }
    const re = globToRegExp(args.glob);
    const hits: { rel: string; mtime: number }[] = [];
    let scanned = 0;
    for await (const { abs, rel } of walkFiles(root)) {
      if (ctx.signal?.aborted) break; // 尊重 ESC/超时
      if (++scanned > 50000) break; // 巨型树扫描上限
      if (!re.test(rel)) continue;
      try {
        const st = await fs.stat(abs);
        hits.push({ rel, mtime: st.mtimeMs });
      } catch {
        continue;
      }
    }
    if (hits.length === 0) return "(无匹配)";
    hits.sort((a, b) => b.mtime - a.mtime);
    return hits
      .slice(0, MAX)
      .map((h) => h.rel)
      .join("\n");
  },
});
