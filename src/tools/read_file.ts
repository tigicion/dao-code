import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool } from "./types.js";
import { classifyPath } from "./paths.js";
import { msg } from "./lang.js";

export const readFileTool = defineTool({
  name: "read_file",
  description:
    "读取工作区内的文本文件,返回带行号(1-based)的内容。可用 offset 指定起始行、limit 指定读取行数。",
  descriptionEn:
    "Reads a text file in the workspace, returning content with 1-based line numbers. Use offset for the starting line and limit to control lines read.",
  capability: "read",
  approval: "auto",
  schema: z.object({
    path: z.string().describe("相对工作区根目录的文件路径"),
    offset: z.number().int().min(1).optional().describe("起始行号(1-based,含)"),
    limit: z.number().int().min(1).optional().describe("最多读取的行数"),
  }),
  handler: async (args, ctx) => {
    const { abs, external } = classifyPath(ctx.workspaceRoot, args.path);
    if (external && !(await (ctx.approveExternalRead?.(abs) ?? Promise.resolve(false)))) {
      return msg(
        `Error: ${args.path} 在工作区之外,未获授权访问(可在弹出的授权中放行)。`,
        `Error: ${args.path} is outside the workspace; access not authorized (you may grant access in the popup).`,
      );
    }
    // 大小护栏:超大文件不整读(防 OOM/爆上下文),提示用 offset/limit 或 grep_files。
    const st = await fs.stat(abs);
    const MAX_BYTES = 5 * 1024 * 1024;
    if (st.size > MAX_BYTES && args.offset === undefined && args.limit === undefined) {
      return msg(
        `Error: 文件过大(${(st.size / 1024 / 1024).toFixed(1)}MB > 5MB)。请用 offset/limit 分段读,或用 grep_files 精确定位。`,
        `Error: File too large (${(st.size / 1024 / 1024).toFixed(1)}MB > 5MB). Use offset/limit to read in sections, or grep_files for targeted search.`,
      );
    }
    const raw = await fs.readFile(abs, "utf8");
    // 二进制探测:含 NUL 字节大概率是二进制,整块乱码塞进上下文无意义。
    if (raw.includes("\u0000")) return msg(
      `Error: 看起来是二进制文件(含 NUL 字节),read_file 只读文本。`,
      `Error: Appears to be a binary file (contains NUL bytes); read_file only reads text.`,
    );
    ctx.readFiles?.add(abs);
    ctx.readMeta?.set(abs, { mtime: st.mtimeMs, size: st.size }); // P2-23 记录读时元信息
    const lines = raw.split("\n");
    const start = args.offset ? args.offset - 1 : 0;
    if (start >= lines.length && lines.length > 0) {
      return msg(
        `(offset ${args.offset} 超过文件总行数 ${lines.length})`,
        `(offset ${args.offset} exceeds total line count ${lines.length})`,
      );
    }
    // 默认行上限(CC 式):不指定 limit 时只读前 DEFAULT_MAX_LINES 行,防一次整读大文件爆上下文
    // (进而逐字进压缩保留的近期轮 → tail 膨胀)。要更多让模型用 offset 续读或 grep_files 精确定位。
    const DEFAULT_MAX_LINES = 2000;
    const end = args.limit !== undefined ? start + args.limit : Math.min(lines.length, start + DEFAULT_MAX_LINES);
    const LINE_CAP = 2000; // 单行上限:压缩代码/内联 base64 sourcemap 等超长行截断,防污染上下文
    const body = lines
      .slice(start, end)
      .map((line, i) => {
        const l = line.length > LINE_CAP ? `${line.slice(0, LINE_CAP)}…${msg(`(本行共 ${line.length} 字符,已截断)`, `(line has ${line.length} chars, truncated)`)}` : line;
        return `${start + i + 1}\t${l}`;
      })
      .join("\n");
    // 因默认上限而截断(用户没显式给 limit)→ 提示如何续读,别让模型误以为已读全。
    const more = args.limit === undefined && end < lines.length
      ? msg(
        `\n…(文件共 ${lines.length} 行,默认只显示前 ${DEFAULT_MAX_LINES} 行;用 offset=${end + 1} 续读,或用 grep_files 精确定位)`,
        `\n…(File has ${lines.length} lines total; showing first ${DEFAULT_MAX_LINES} by default; use offset=${end + 1} to continue, or grep_files for targeted search)`,
      )
      : "";
    return body + more;
  },
});
