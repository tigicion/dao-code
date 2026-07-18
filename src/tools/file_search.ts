import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool } from "./types.js";
import { classifyPath } from "./paths.js";
import { walkFiles } from "./walk.js";
import { globToRegExp } from "./glob.js";
import { msg } from "./lang.js";

const MAX = 100;

export const fileSearchTool = defineTool({
  name: "Glob",
  description: "在工作区内按文件名/路径 glob 搜索文件(如 *.ts 只匹配文件名、**/*.test.ts 能跨目录匹配完整相对路径)," +
    "按修改时间从新到旧排序——想找'最近改过的那个 xxx 文件'时这个排序很有用,不用自己再猜。可用 path 限定只搜某个子目录。" +
    "按文件名/路径找文件优先用本工具,不要用 Bash 拼 find——不占审批。这是纯按名字/路径匹配,不看文件内容," +
    "按内容找用 Grep。\n" +
    "边界:最多返回 100 个结果(比 Grep 的 200 更少,大仓库模糊 glob 容易一下命中很多,想要更精确用更窄的 glob" +
    "或配合 path);查无匹配就是没有,不会像 Grep 那样回显搜索范围,自己确认 glob 写对了。举例:想找刚编辑过的那个" +
    "测试文件但记不清具体名字,glob 传 *.test.ts 配合按修改时间排序,通常第一条就是。",
  descriptionEn: "Searches files by name/path glob in the workspace (e.g., *.ts matches by filename only, **/*.test.ts matches the full relative path across directories), " +
    "sorted by modification time (newest first) — handy for finding 'the xxx file I just edited' without guessing. Use path to limit to a subdirectory. " +
    "Prefer this over shelling out to find via Bash — no approval needed. This matches by name/path only, not content — use Grep for content search.\n" +
    "Boundaries: at most 100 results (fewer than Grep's 200 — a loose glob on a large repo can match a lot; narrow the glob or add path for precision); " +
    "an empty match just means nothing found — unlike Grep it doesn't echo back the search scope, so double-check the glob is correct. Example: you can't recall " +
    "the exact name of a test file you just edited — pass *.test.ts and rely on the newest-first sort; the one you want is usually first.",
  capability: "read",
  approval: "auto",
  schema: z.object({
    glob: z.string().describe("文件名/路径 glob"),
    path: z.string().optional().describe("搜索子目录,默认工作区根"),
  }),
  handler: async (args, ctx) => {
    const { abs: root, external } = classifyPath(ctx.cwd ?? ctx.workspaceRoot, args.path ?? ".");
    if (external && !(await (ctx.approveExternalRead?.(root) ?? Promise.resolve(false)))) {
      return msg(
        `Error: ${args.path} 在工作区之外,未获授权访问(可在弹出的授权中放行)。`,
        `Error: ${args.path} is outside the workspace; access not authorized (you may grant access in the popup).`,
      );
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
