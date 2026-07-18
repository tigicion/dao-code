import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool } from "./types.js";
import { classifyPath } from "./paths.js";
import { msg } from "./lang.js";

export const listDirTool = defineTool({
  name: "ListDir",
  description: "列出工作区内某个目录的条目(只列这一层,不递归子目录),目录名以 / 结尾,按字典序排列。" +
    "不给 path 就列工作区根目录。想探一层层往下看用它;想找某个具体文件/按名字模式找,直接用 Glob 更快," +
    "不用先 ListDir 一层层翻。超过 500 项会截断(如 node_modules),此时改用 Grep/Glob 精确定位而非翻列表。" +
    "典型用法:刚接手一个陌生项目,先 ListDir 根目录看大致结构(有哪些顶层目录、配置文件),再决定往哪个子目录深入," +
    "而不是一上来就用 Glob 漫无目的地搜。目录本身不存在或不是目录会明确报错,不会静默返回空列表让你误以为它是空目录。" +
    "目录项和文件混在同一层列表里,靠结尾的 / 区分,别把目录当文件直接拿去 Read。",
  descriptionEn: "Lists entries in a workspace directory (this level only, not recursive), directory names end with /, sorted alphabetically. " +
    "Omit path to list the workspace root. Use this to explore level by level; to find a specific file or name pattern, use Glob directly — " +
    "faster than browsing down one directory at a time. Truncates past 500 entries (e.g. node_modules) — use Grep/Glob to target precisely instead of browsing the list. " +
    "Typical use: when first exploring an unfamiliar project, ListDir the root to see the overall structure (top-level directories, config files) before " +
    "deciding which subdirectory to dig into, rather than searching aimlessly with Glob right away. A nonexistent path or non-directory path errors clearly, " +
    "rather than silently returning an empty list that could be mistaken for a genuinely empty directory. Directories and files are listed together at the same level, " +
    "distinguished only by the trailing / — don't mistake a directory entry for a file and pass it to Read.",
  capability: "read",
  approval: "auto",
  schema: z.object({
    path: z.string().optional().describe("相对工作区根目录的目录路径,默认根目录"),
  }),
  handler: async (args, ctx) => {
    const { abs, external } = classifyPath(ctx.cwd ?? ctx.workspaceRoot, args.path ?? ".");
    if (external && !(await (ctx.approveExternalRead?.(abs) ?? Promise.resolve(false)))) {
      return msg(
        `Error: ${args.path} 在工作区之外,未获授权访问(可在弹出的授权中放行)。`,
        `Error: ${args.path} is outside the workspace; access not authorized (you may grant access in the popup).`,
      );
    }
    const entries = await fs.readdir(abs, { withFileTypes: true });
    if (entries.length === 0) return msg("(空目录)", "(empty directory)");
    const sorted = [...entries]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    const MAX = 500; // 超大目录(如 node_modules)截断,防撑爆上下文
    if (sorted.length > MAX) {
      return sorted.slice(0, MAX).join("\n") + `\n…(共 ${sorted.length} 项,已截断前 ${MAX};用 Grep/Glob 精确定位)`;
    }
    return sorted.join("\n");
  },
});
