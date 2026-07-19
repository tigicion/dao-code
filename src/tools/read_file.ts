import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "./types.js";
import { classifyPath, isImagePath, detectImageFormat } from "./paths.js";
import { msg } from "./lang.js";
import { supportsVision } from "../config/profiles.js";

export const readFileTool = defineTool({
  name: "Read",
  description:
    "读取工作区内的文本文件,返回带行号(1-based,制表符分隔)的内容。可用 offset 指定起始行、limit 指定读取行数。" +
    "读文件优先用本工具,不要用 Bash 拼 cat/head/tail——那样拿不到行号,也绕不开下面这些护栏。\n" +
    "支持文本和图片文件(png/jpg/gif/webp);图片以 base64 内联返回供多模态模型查看(仅 kimi-k2.6 等支持视觉的模型可用)。\n" +
    "边界:只读文本,遇二进制(含 NUL 字节)或超大文件(>5MB 且未给 offset/limit)会报错,不会返回乱码;" +
    "单行超 2000 字符会截断(防压缩过的代码/内联 base64 sourcemap 撑爆上下文);" +
    "不给 limit 时默认只读前 2000 行,截断处会提示续读的 offset,别误以为已经读完整个文件——" +
    "大文件想找具体内容,直接用 Grep 定位行号,比一段段翻页更快。\n" +
    "工作区外的路径需要用户在弹出的授权里放行才能读。\n" +
    "副作用:成功读过的文件会被记入'已读'状态和当时的 mtime/size 基线——Write/Edit 依此判断" +
    "'编辑前是否读过'和'磁盘内容是否被外部改过'(改文件前必须先读它,就是为了建立这个基线)。",
  descriptionEn:
    "Reads a text file in the workspace, returning content with 1-based line numbers (tab-separated). Use offset for the starting line and limit to control lines read. " +
    "Supports text and image files (png/jpg/gif/webp); images are returned as inline base64 for multimodal models (only vision-capable models like kimi-k2.6). " +
    "Prefer this over shelling out to cat/head/tail via Bash — those give no line numbers and bypass the guardrails below.\n" +
    "Boundaries: text only — errors (not garbage output) on binary (NUL bytes) or oversized files (>5MB without offset/limit); " +
    "lines over 2000 chars get truncated (protects against minified code or inline base64 sourcemaps blowing up context); " +
    "without limit, only the first 2000 lines are read by default — the truncation notice gives you the offset to continue, don't assume the whole file was read. " +
    "For large files, Grep to locate the right lines beats paging through with repeated reads.\n" +
    "Paths outside the workspace require the user to grant access via a popup.\n" +
    "Side effect: a successful read records the file as 'read' plus its mtime/size baseline — Write/Edit rely on this to check " +
    "'was it read before editing' and 'did the file change externally since' (this is exactly why editing requires reading first).",
  capability: "read",
  approval: "auto",
  schema: z.object({
    path: z.string().describe("相对工作区根目录的文件路径"),
    offset: z.number().int().min(1).optional().describe("起始行号(1-based,含)"),
    limit: z.number().int().min(1).optional().describe("最多读取的行数"),
  }),
  handler: async (args, ctx) => {
    const { abs, external } = classifyPath(ctx.cwd ?? ctx.workspaceRoot, args.path);
    if (external && !(await (ctx.approveExternalRead?.(abs) ?? Promise.resolve(false)))) {
      return msg(
        `Error: ${args.path} 在工作区之外,未获授权访问(可在弹出的授权中放行)。`,
        `Error: ${args.path} is outside the workspace; access not authorized (you may grant access in the popup).`,
      );
    }
    // 大小护栏:超大文件不整读(防 OOM/爆上下文),提示用 offset/limit 或 Grep。
    const st = await fs.stat(abs);
    const MAX_BYTES = 5 * 1024 * 1024;
    if (st.size > MAX_BYTES && args.offset === undefined && args.limit === undefined) {
      return msg(
        `Error: 文件过大(${(st.size / 1024 / 1024).toFixed(1)}MB > 5MB)。请用 offset/limit 分段读,或用 Grep 精确定位。`,
        `Error: File too large (${(st.size / 1024 / 1024).toFixed(1)}MB > 5MB). Use offset/limit to read in sections, or Grep for targeted search.`,
      );
    }
    // 图片文件:读原始 buffer → magic bytes 探测格式 → base64 暂存到 ctx(execute.ts 构造 ContentPart[])
    if (isImagePath(args.path)) {
      const buf = await fs.readFile(abs);
      if (buf.length > MAX_BYTES) {
        return msg(
          `Error: 图片过大(${(buf.length / 1024 / 1024).toFixed(1)}MB > 5MB)。`,
          `Error: Image too large (${(buf.length / 1024 / 1024).toFixed(1)}MB > 5MB).`,
        );
      }
      const mediaType = detectImageFormat(buf);
      if (!mediaType) {
        return msg(
          `Error: 无法识别图片格式,支持 png/jpg/gif/webp。`,
          `Error: Unrecognized image format. Supported: png/jpg/gif/webp.`,
        );
      }
      // 不支持多模态的模型:拒绝读图片
      if (ctx.sessionModel && !supportsVision(ctx.sessionModel)) {
        return `Error: 当前模型 ${ctx.sessionModel} 不支持图片输入,无法读取图片文件。`;
      }
      ctx.currentImageData = { base64: buf.toString("base64"), mediaType };
      return msg(
        `[已读取图片: ${path.basename(args.path)} (${buf.length} bytes, ${mediaType})]`,
        `[Image loaded: ${path.basename(args.path)} (${buf.length} bytes, ${mediaType})]`,
      );
    }
    const raw = await fs.readFile(abs, "utf8");
    // 二进制探测:含 NUL 字节大概率是二进制,整块乱码塞进上下文无意义。
    if (raw.includes("\u0000")) return msg(
      `Error: 看起来是二进制文件(含 NUL 字节),Read 只读文本。`,
      `Error: Appears to be a binary file (contains NUL bytes); Read only reads text.`,
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
    // (进而逐字进压缩保留的近期轮 → tail 膨胀)。要更多让模型用 offset 续读或 Grep 精确定位。
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
        `\n…(文件共 ${lines.length} 行,默认只显示前 ${DEFAULT_MAX_LINES} 行;用 offset=${end + 1} 续读,或用 Grep 精确定位)`,
        `\n…(File has ${lines.length} lines total; showing first ${DEFAULT_MAX_LINES} by default; use offset=${end + 1} to continue, or Grep for targeted search)`,
      )
      : "";
    // fire-and-forget:动态发现 .dao/skills/ + 条件 skill 路径匹配(不阻塞读操作)
    ctx.onFileAccessed?.(abs).catch(() => {});
    return body + more;
  },
});
