import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool } from "./types.js";
import { resolveInWorkspace } from "./paths.js";

export const readFileTool = defineTool({
  name: "read_file",
  description:
    "读取工作区内的文本文件,返回带行号(1-based)的内容。可用 offset 指定起始行、limit 指定读取行数。",
  capability: "read",
  approval: "auto",
  schema: z.object({
    path: z.string().describe("相对工作区根目录的文件路径"),
    offset: z.number().int().min(1).optional().describe("起始行号(1-based,含)"),
    limit: z.number().int().min(1).optional().describe("最多读取的行数"),
  }),
  handler: async (args, ctx) => {
    const abs = resolveInWorkspace(ctx.workspaceRoot, args.path);
    const raw = await fs.readFile(abs, "utf8");
    ctx.readFiles?.add(abs);
    const lines = raw.split("\n");
    const start = args.offset ? args.offset - 1 : 0;
    const end = args.limit !== undefined ? start + args.limit : lines.length;
    return lines
      .slice(start, end)
      .map((line, i) => `${start + i + 1}\t${line}`)
      .join("\n");
  },
});
