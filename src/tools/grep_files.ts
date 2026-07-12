import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool } from "./types.js";
import { classifyPath } from "./paths.js";
import { walkFiles } from "./walk.js";
import { globToRegExp } from "./glob.js";
import { clampOutput } from "./output.js";
import { msg } from "./lang.js";

const MAX = 200;

export const grepFilesTool = defineTool({
  name: "grep_files",
  description:
    "在工作区内按内容(正则,JS 语法)搜索文本文件。mode=content(默认)返回 路径:行号:行内容;mode=files 只返回命中文件名," +
    "只想知道哪些文件有匹配、不需要看具体行时用它更省。可用 glob(如 *.ts)过滤文件名、path 限定搜索子目录、" +
    "ignore_case 忽略大小写。内容搜索优先用本工具,不要用 exec_shell 拼 grep/rg——结果格式统一、不占审批。\n" +
    "边界:结果最多 200 条(文件级或行级,按 mode 定),单行超 300 字符会截断;二进制文件自动跳过,不会读出乱码。" +
    "查无结果时会把'在哪个目录、按什么正则/glob 搜的'原样回显——据此判断是不是 path 设窄了或 pattern 写错了," +
    "别对着同一次失败的搜索盲目重试。搜大型仓库时如果结果被截断(提示会说明),缩小 path 或收紧 pattern/glob 再搜," +
    "而不是假设已经看到了全部匹配。",
  descriptionEn:
    "Searches text files in the workspace by content regex (JS syntax). mode=content (default) returns path:line:content; mode=files returns only matching filenames — " +
    "cheaper when you just need to know which files match, not the specific lines. Filter by glob (e.g. *.ts), limit to a subdirectory via path, ignore_case for case-insensitive. " +
    "Prefer this over shelling out to grep/rg via exec_shell — consistent output format, no approval needed.\n" +
    "Boundaries: at most 200 results (file- or line-level depending on mode); lines over 300 chars are truncated; binary files are silently skipped, never returned as garbage. " +
    "An empty result echoes back exactly where and with what pattern/glob it searched — use that to tell whether path was too narrow or the pattern is wrong, rather than blindly " +
    "retrying the same failed search. If results were truncated (the message says so) on a large repo, narrow path or tighten pattern/glob and search again — don't assume you've " +
    "seen every match.",
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
    const { abs: root, external } = classifyPath(ctx.workspaceRoot, args.path ?? ".");
    if (external && !(await (ctx.approveExternalRead?.(root) ?? Promise.resolve(false)))) {
      return msg(
        `Error: ${args.path} 在工作区之外,未获授权访问(可在弹出的授权中放行)。`,
        `Error: ${args.path} is outside the workspace; access not authorized (you may grant access in the popup).`,
      );
    }
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
    let scanned = 0;

    outer: for await (const { abs, rel } of walkFiles(root)) {
      if (ctx.signal?.aborted) break; // 尊重 ESC/超时
      if (++scanned > 50000) { truncated = true; break; } // 巨型树扫描上限
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
    if (out.length === 0) {
      // 回显搜索范围,模型才看得出是不是把 path 设窄了(否则只会盲目重试同一次失败搜索)。
      const scope = `在 ${args.path ?? "工作区根"} 内搜 /${args.pattern}/${args.glob ? `,glob ${args.glob}` : ""}`;
      return `(无匹配:${scope}。若确信存在,放宽 path 或检查 pattern/glob)`;
    }
    // 行数已由 MAX=200、单行 300 字符封顶;再过 clampOutput 兜一道硬字符上限(最坏 200×长路径仍可能超 16k),
    // 保证 grep 结果绝不撑爆上下文。超限时中间截断、提示缩小范围。
    return clampOutput(out.join("\n") + (truncated ? `\n…(已截断,超过 ${MAX} 条)` : ""));
  },
});
