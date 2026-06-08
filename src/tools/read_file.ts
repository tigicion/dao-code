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
    // 大小护栏:超大文件不整读(防 OOM/爆上下文),提示用 offset/limit 或 grep_files。
    const st = await fs.stat(abs);
    const MAX_BYTES = 5 * 1024 * 1024;
    if (st.size > MAX_BYTES && args.offset === undefined && args.limit === undefined) {
      return `Error: 文件过大(${(st.size / 1024 / 1024).toFixed(1)}MB > 5MB)。请用 offset/limit 分段读,或用 grep_files 精确定位。`;
    }
    const raw = await fs.readFile(abs, "utf8");
    // 二进制探测:含 NUL 字节大概率是二进制,整块乱码塞进上下文无意义。
    if (raw.includes("\u0000")) return `Error: 看起来是二进制文件(含 NUL 字节),read_file 只读文本。`;
    ctx.readFiles?.add(abs);
    const lines = raw.split("\n");
    const start = args.offset ? args.offset - 1 : 0;
    if (start >= lines.length && lines.length > 0) {
      return `(offset ${args.offset} 超过文件总行数 ${lines.length})`;
    }
    const end = args.limit !== undefined ? start + args.limit : lines.length;
    return lines
      .slice(start, end)
      .map((line, i) => `${start + i + 1}\t${line}`)
      .join("\n");
  },
});
