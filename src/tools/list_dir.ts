import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "./types.js";

export const listDirTool = defineTool({
  name: "list_dir",
  description: "列出工作区内某个目录的条目,目录名以 / 结尾,按字典序排列。",
  capability: "read",
  approval: "auto",
  schema: z.object({
    path: z.string().optional().describe("相对工作区根目录的目录路径,默认根目录"),
  }),
  handler: async (args, ctx) => {
    const abs = path.resolve(ctx.workspaceRoot, args.path ?? ".");
    const entries = await fs.readdir(abs, { withFileTypes: true });
    if (entries.length === 0) return "(空目录)";
    return entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .join("\n");
  },
});
