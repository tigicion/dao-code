import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool } from "./types.js";
import { resolveInWorkspace } from "./paths.js";
import { walkFiles } from "./walk.js";
import { globToRegExp } from "./glob.js";

const MAX = 200;

export const grepFilesTool = defineTool({
  name: "grep_files",
  description:
    "在工作区内按内容(正则)搜索文本文件。mode=content(默认)返回 路径:行号:行内容;mode=files 只返回命中文件名。可用 glob 过滤文件名。",
  capability: "read",
  approval: "auto",
  schema: z.object({
    pattern: z.string().describe("正则表达式"),
    path: z.string().optional().describe("搜索子目录,默认工作区根"),
    glob: z.string().optional().describe("文件名 glob 过滤,如 *.ts"),
    mode: z.enum(["content", "files"]).optional().describe("content(默认)或 files"),
    ignore_case: z.boolean().optional().describe("忽略大小写"),
  }),
  handler: async (args, ctx) => {
    const root = resolveInWorkspace(ctx.workspaceRoot, args.path ?? ".");
    let re: RegExp;
    try {
      re = new RegExp(args.pattern, args.ignore_case ? "i" : "");
    } catch (e) {
      throw new Error(`无效正则:${(e as Error).message}`);
    }
    const nameRe = args.glob ? globToRegExp(args.glob) : null;
    const mode = args.mode ?? "content";
    const contentLines: string[] = [];
    const fileHits: string[] = [];
    let truncated = false;

    outer: for await (const { abs, rel } of walkFiles(root)) {
      const base = rel.split(/[/\\]/).pop()!;
      if (nameRe && !nameRe.test(base)) continue;
      let raw: string;
      try {
        raw = await fs.readFile(abs, "utf8");
      } catch {
        continue;
      }
      if (raw.includes("\u0000")) continue; // 跳过二进制
      const lines = raw.split("\n");
      let fileMatched = false;
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          fileMatched = true;
          if (mode === "content") {
            contentLines.push(`${rel}:${i + 1}:${lines[i]!.slice(0, 300)}`);
            if (contentLines.length >= MAX) {
              truncated = true;
              break outer;
            }
          } else {
            break;
          }
        }
      }
      if (mode === "files" && fileMatched) {
        fileHits.push(rel);
        if (fileHits.length >= MAX) {
          truncated = true;
          break;
        }
      }
    }

    const out = mode === "content" ? contentLines : fileHits;
    if (out.length === 0) return "(无匹配)";
    return out.join("\n") + (truncated ? `\n…(已截断,超过 ${MAX} 条)` : "");
  },
});
