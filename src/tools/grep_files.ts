import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool } from "./types.js";
import { classifyPath } from "./paths.js";
import { walkFiles } from "./walk.js";
import { globToRegExp } from "./glob.js";
import { clampOutput } from "./output.js";
import { msg } from "./lang.js";

const MAX = 200;
const LINE_TRUNC = 300;
const SNIPPET_CAP = 500;

// 整行超过 LINE_TRUNC 时截断并显式标注字符数(不像之前那样静默切断)
const truncateLine = (line: string): string =>
  line.length > LINE_TRUNC
    ? `${line.slice(0, LINE_TRUNC)}…${msg(`(该行共 ${line.length} 字符,已截断)`, `(line has ${line.length} chars, truncated)`)}`
    : line;

// only_matching 模式:只截取匹配文本本身(用 << >> 标出边界)+ 前后 contextChars 个字符,
// 不受整行长度影响--用于核实超长行里一个匹配到底是不是真的命中了预期内容。
const buildMatchSnippet = (source: string, matchStart: number, matchLen: number, contextChars: number): string => {
  const matched = source.slice(matchStart, matchStart + matchLen);
  if (matched.length > SNIPPET_CAP) {
    return `<<${matched.slice(0, SNIPPET_CAP)}…${msg(`(匹配文本共 ${matched.length} 字符,已截断)`, `(matched text is ${matched.length} chars, truncated)`)}>>`;
  }
  const from = Math.max(0, matchStart - contextChars);
  const to = Math.min(source.length, matchStart + matchLen + contextChars);
  const before = source.slice(from, matchStart);
  const after = source.slice(matchStart + matchLen, to);
  const prefixEllipsis = from > 0 ? "…" : "";
  const suffixEllipsis = to < source.length ? "…" : "";
  if (before.length + matched.length + after.length > SNIPPET_CAP) {
    const capEach = Math.max(0, Math.floor((SNIPPET_CAP - matched.length) / 2));
    return `${prefixEllipsis}${before.slice(-capEach)}<<${matched}>>${after.slice(0, capEach)}…${msg("(上下文过长已截断)", "(context truncated)")}`;
  }
  return `${prefixEllipsis}${before}<<${matched}>>${after}${suffixEllipsis}`;
};

// 文件类型 -> 扩展名集合(参考 Grep 的 type 参数)
const TYPE_EXTENSIONS: Record<string, string[]> = {
  js: [".js", ".jsx", ".mjs", ".cjs"],
  ts: [".ts", ".tsx", ".mts", ".cts"],
  py: [".py", ".pyw"],
  go: [".go"],
  rust: [".rs"],
  java: [".java"],
  c: [".c", ".h"],
  cpp: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
  rb: [".rb"],
  php: [".php"],
  swift: [".swift"],
  kt: [".kt", ".kts"],
  scala: [".scala", ".sc"],
  sh: [".sh", ".bash", ".zsh"],
  sql: [".sql"],
  html: [".html", ".htm"],
  css: [".css", ".scss", ".sass", ".less"],
  json: [".json"],
  yaml: [".yaml", ".yml"],
  xml: [".xml"],
  md: [".md", ".markdown"],
};

export const grepFilesTool = defineTool({
  name: "Grep",
  description:
    "在工作区内按内容(正则,JS 语法)搜索文本文件。mode=content(默认)返回 路径:行号:行内容;mode=files 只返回命中文件名," +
    "只想知道哪些文件有匹配、不需要看具体行时用它更省。可用 glob(如 *.ts)过滤文件名、path 限定搜索子目录" +
    "(也可以直接指向某个具体文件,只搜这一个)、" +
    "ignore_case 忽略大小写、type 按文件类型过滤(js/ts/py/go/rust/java…)。\n" +
    "上下文行:before/after/context 显示匹配行前/后/前后各 N 行(参考 Grep -A/-B/-C)," +
    "便于理解匹配处的上下文。head_limit 限制返回条数(默认 200),offset 跳过前 N 条(分页)。" +
    "multiline=true 启用跨行匹配(. 匹配换行符,模式可跨行)。\n" +
    "内容搜索优先用本工具,不要用 Bash 拼 grep/rg--结果格式统一、不占审批。\n" +
    "边界:结果最多 head_limit 条(默认 200,文件级或行级,按 mode 定),单行超 300 字符会截断,截断处会像 Read 一样" +
    "标注'该行共 N 字符,已截断'(不是静默切断);二进制文件自动跳过,不会读出乱码。" +
    "查无结果时会把'在哪个目录、按什么正则/glob 搜的'原样回显--据此判断是不是 path 设窄了或 pattern 写错了," +
    "别对着同一次失败的搜索盲目重试。搜大型仓库时如果结果被截断(提示会说明),缩小 path 或收紧 pattern/glob 再搜," +
    "而不是假设已经看到了全部匹配。\n" +
    "only_matching=true(类似 grep -o):只返回匹配到的文本本身(用 <<...>> 标出精确边界),不受整行 300 字符截断" +
    "影响--命中出现在超长行(如压缩 JSON/日志里几万字符的一行)时,想确认这个匹配到底是不是真的命中了完整的" +
    "预期内容(比如核实一段疑似密钥的完整值),用这个而不是被整行截断挡住看不到的部分误导。" +
    "match_context 配合使用,指定匹配前后额外显示的字符数(非整行,默认 0)。",
  descriptionEn:
    "Searches text files in the workspace by content regex (JS syntax). mode=content (default) returns path:line:content; mode=files returns only matching filenames - " +
    "cheaper when you just need to know which files match, not the specific lines. Filter by glob (e.g. *.ts), limit to a subdirectory via path (path can also point straight at a " +
    "single file to search just that one), ignore_case for case-insensitive, " +
    "type for file type filtering (js/ts/py/go/rust/java...).\n" +
    "Context lines: before/after/context show N lines before/after/around matches (like CC Grep -A/-B/-C). " +
    "head_limit caps result count (default 200), offset skips first N results (pagination). multiline=true enables cross-line matching (. matches newlines).\n" +
    "Prefer this over shelling out to grep/rg via Bash - consistent output format, no approval needed.\n" +
    "Boundaries: at most head_limit results (default 200, file- or line-level depending on mode); lines over 300 chars are truncated, and the truncation point says 'line has N " +
    "chars, truncated' just like Read (never silent); binary files are silently skipped, never returned as garbage. " +
    "An empty result echoes back exactly where and with what pattern/glob it searched - use that to tell whether path was too narrow or the pattern is wrong, rather than blindly " +
    "retrying the same failed search. If results were truncated (the message says so) on a large repo, narrow path or tighten pattern/glob and search again - don't assume you've " +
    "seen every match.\n" +
    "only_matching=true (like grep -o): returns only the matched text itself (bounded exactly with <<...>>), unaffected by the 300-char line truncation - use this when a hit lands " +
    "on a huge line (minified JSON, a giant log line) and you need to confirm whether it actually matched the full expected content (e.g. verifying a suspected secret's complete " +
    "value) instead of being misled by content the line truncation hid. Pair with match_context to show N extra chars (not lines) around the match, default 0.",
  capability: "read",
  approval: "auto",
  schema: z.object({
    pattern: z.string().describe("正则表达式"),
    path: z.string().optional().describe("搜索子目录或具体某个文件,默认工作区根"),
    glob: z.string().optional().describe("文件名 glob 过滤,如 *.ts"),
    mode: z.enum(["content", "files"]).optional().describe("content(默认)或 files"),
    ignore_case: z.boolean().optional().describe("忽略大小写"),
    before: z.number().int().min(0).optional().describe("匹配行前显示 N 行(参考 -B)"),
    after: z.number().int().min(0).optional().describe("匹配行后显示 N 行(参考 -A)"),
    context: z.number().int().min(0).optional().describe("匹配行前后各显示 N 行(参考 -C);与 before/after 取 max"),
    head_limit: z.number().int().min(1).optional().describe("限制返回条数,默认 200"),
    offset: z.number().int().min(0).optional().describe("跳过前 N 条结果(分页),默认 0"),
    multiline: z.boolean().optional().describe("跨行匹配(. 匹配换行符,模式可跨行)"),
    type: z.string().optional().describe("文件类型过滤(js/ts/py/go/rust/java/c/cpp/rb/php/swift/kt/scala/sh/sql/html/css/json/yaml/xml/md)"),
    only_matching: z.boolean().optional().describe(
      "只返回匹配文本本身(用 <<...>> 标出边界,类似 grep -o),不受整行 300 字符截断影响;" +
      "用于核实超长行里的匹配是否命中了完整预期内容",
    ),
    match_context: z.number().int().min(0).max(200).optional().describe(
      "仅 only_matching=true 时生效:匹配前后额外显示的字符数(非整行),默认 0",
    ),
  }),
  handler: async (args, ctx) => {
    const { abs: root, external } = classifyPath(ctx.cwd ?? ctx.workspaceRoot, args.path ?? ".");
    if (external && !(await (ctx.approveExternalRead?.(root) ?? Promise.resolve(false)))) {
      return msg(
        `Error: ${args.path} 在工作区之外,未获授权访问(可在弹出的授权中放行)。`,
        `Error: ${args.path} is outside the workspace; access not authorized (you may grant access in the popup).`,
      );
    }
    let re: RegExp;
    const flags = args.ignore_case ? "gi" : "g";
    try {
      re = new RegExp(args.pattern, args.multiline ? flags + "s" : flags);
    } catch (e) {
      throw new Error(`无效正则:${(e as Error).message}`);
    }
    const nameRe = args.glob ? globToRegExp(args.glob) : null;
    const typeExts = args.type ? TYPE_EXTENSIONS[args.type.toLowerCase()] ?? null : null;
    const mode = args.mode ?? "content";
    const maxResults = args.head_limit ?? MAX;
    const skip = args.offset ?? 0;
    // 上下文行数:context 与 before/after 取 max
    const before = Math.max(args.before ?? 0, args.context ?? 0);
    const after = Math.max(args.after ?? 0, args.context ?? 0);
    const wantContext = before > 0 || after > 0;
    const onlyMatching = args.only_matching ?? false;
    const matchContext = args.match_context ?? 0;

    const contentLines: string[] = [];
    const fileHits: string[] = [];
    let truncated = false;
    let scanned = 0;
    let totalMatches = 0; // 含跳过的(offset)

    const matchType = (rel: string): boolean => {
      if (!typeExts) return true;
      return typeExts.some((ext) => rel.endsWith(ext));
    };

    // multiline 模式:对全文做一次正则匹配,记录匹配起始位置对应的行号/列号/精确跨度
    const matchMultiline = (raw: string, lines: string[]): { lineIdx: number; col: number; matchStart: number; matchLen: number }[] => {
      const hits: { lineIdx: number; col: number; matchStart: number; matchLen: number }[] = [];
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(raw)) !== null) {
        if (m[0] === "") { re.lastIndex++; continue; } // 零宽匹配前进防死循环
        const prefix = raw.slice(0, m.index);
        const lineIdx = prefix.split("\n").length - 1;
        const lastNl = prefix.lastIndexOf("\n");
        const col = m.index - (lastNl + 1);
        if (lineIdx < lines.length) {
          // 去重:同一行已有匹配则跳过(跨行匹配可能多次命中同一起始行)
          if (!hits.some((h) => h.lineIdx === lineIdx)) {
            hits.push({ lineIdx, col, matchStart: m.index, matchLen: m[0].length });
          }
        }
      }
      return hits;
    };

    // 收集上下文行(合并连续行,去重);marker: > 表示匹配行,- 表示上下文行
    const collectContext = (
      lines: string[],
      matchIdx: number,
      rel: string,
      collected: Set<number>,
      out: string[],
    ): void => {
      const start = Math.max(0, matchIdx - before);
      const end = Math.min(lines.length - 1, matchIdx + after);
      for (let i = start; i <= end; i++) {
        if (collected.has(i)) continue;
        collected.add(i);
        const marker = i === matchIdx ? ">" : "-";
        out.push(`${rel}:${i + 1}:${marker} ${truncateLine(lines[i]!)}`);
      }
    };

    outer: for await (const { abs, rel } of walkFiles(root)) {
      if (ctx.signal?.aborted) break;
      if (++scanned > 50000) { truncated = true; break; }
      const base = rel.split(/[/\\]/).pop()!;
      if (nameRe && !nameRe.test(base)) continue;
      if (!matchType(rel)) continue;
      let raw: string;
      try {
        raw = await fs.readFile(abs, "utf8");
      } catch {
        continue;
      }
      if (raw.includes("\u0000")) continue;
      const lines = raw.split("\n");
      let fileMatched = false;

      if (args.multiline) {
        const hits = matchMultiline(raw, lines);
        for (const { lineIdx, col, matchStart, matchLen } of hits) {
          fileMatched = true;
          if (mode === "content") {
            totalMatches++;
            if (totalMatches <= skip) continue;
            if (onlyMatching) {
              contentLines.push(`${rel}:${lineIdx + 1}:${col + 1}:${buildMatchSnippet(raw, matchStart, matchLen, matchContext)}`);
            } else if (wantContext) {
              const collected = new Set<number>();
              collectContext(lines, lineIdx, rel, collected, contentLines);
            } else {
              contentLines.push(`${rel}:${lineIdx + 1}:${truncateLine(lines[lineIdx]!)}`);
            }
            if (contentLines.length >= maxResults) { truncated = true; break outer; }
          } else {
            break;
          }
        }
      } else {
        const collectedLineNums = new Set<number>();
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          re.lastIndex = 0; // 全局 flag g 会累积,逐行重置
          if (!re.test(line)) continue;
          fileMatched = true;
          if (mode !== "content") break; // files 模式:命中一行就够了

          if (onlyMatching) {
            // 同一行可能有多个匹配,逐个取出精确边界,不受整行截断影响
            re.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = re.exec(line)) !== null) {
              if (m[0] === "") { re.lastIndex++; continue; }
              totalMatches++;
              if (totalMatches <= skip) continue;
              contentLines.push(`${rel}:${i + 1}:${m.index + 1}:${buildMatchSnippet(line, m.index, m[0].length, matchContext)}`);
              if (contentLines.length >= maxResults) { truncated = true; break outer; }
            }
          } else {
            totalMatches++;
            if (totalMatches <= skip) continue;
            if (wantContext) {
              collectContext(lines, i, rel, collectedLineNums, contentLines);
            } else {
              contentLines.push(`${rel}:${i + 1}:${truncateLine(line)}`);
            }
            if (contentLines.length >= maxResults) { truncated = true; break outer; }
          }
        }
      }

      if (mode === "files" && fileMatched) {
        totalMatches++;
        if (totalMatches <= skip) continue;
        fileHits.push(rel);
        if (fileHits.length >= maxResults) { truncated = true; break; }
      }
    }

    const out = mode === "content" ? contentLines : fileHits;
    if (out.length === 0) {
      const scope = `在 ${args.path ?? "工作区根"} 内搜 /${args.pattern}/${args.glob ? `,glob ${args.glob}` : ""}${args.type ? `,type ${args.type}` : ""}${skip > 0 ? `,跳过前 ${skip} 条` : ""}`;
      const hasMore = totalMatches > skip ? `(共 ${totalMatches} 条匹配,跳过了 ${skip} 条)` : "";
      return `(无匹配:${scope}。${hasMore}若确信存在,放宽 path 或检查 pattern/glob/type)`;
    }
    const offsetNote = skip > 0 ? `\n(跳过前 ${skip} 条,共 ${totalMatches} 条匹配)` : "";
    return clampOutput(out.join("\n") + (truncated ? `\n…(已截断,超过 ${maxResults} 条)` : "") + offsetNote);
  },
});
