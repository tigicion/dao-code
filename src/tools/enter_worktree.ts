import { z } from "zod";
import { defineTool } from "./types.js";

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export const enterWorktreeTool = defineTool({
  name: "EnterWorktree",
  description: "只在用户明确要求'开个 worktree/在 worktree 里做'时用。新建一个独立的 git worktree(新分支," +
    "从 HEAD 检出),把【路径解析根目录】切过去——之后 Read/Write/Grep/Bash/verify 等" +
    "都在这个新目录下进行,不会碰当前工作树的文件,方便和现有改动互不干扰地并行开一条分支。项目身份(MCP/LSP/" +
    "skills/memory/settings)仍指向原项目,不受影响,不会因为进了 worktree 就看不到项目记忆或换了一套工具。" +
    "只能是 git 仓库才能用,非 git 仓库会明确报错。同一时间只能进一个 worktree 会话——已经在里面时再调用会被拒绝," +
    "先用 ExitWorktree 退出当前的。完成后必须用 ExitWorktree 离开(keep 保留改动待用户 review/合并,或 remove 丢弃)。",
  descriptionEn: "Use only when the user explicitly asks to work in a worktree. Creates a new isolated git worktree (new branch, checked out from " +
    "HEAD) and switches the [path-resolution root] to it — Read/Write/Grep/Bash/verify etc. all operate under the new " +
    "directory from then on, leaving the current working tree's files untouched, so you can work on a separate branch without interfering with " +
    "existing changes. Project identity (MCP/LSP/skills/memory/settings) still points at the original project and is unaffected — entering a " +
    "worktree does not hide project memory or swap tools. Requires a git repository; a clear error is returned otherwise. Only one worktree session " +
    "at a time — calling this while already in one is rejected; use ExitWorktree first. Must exit via ExitWorktree when done (keep to preserve " +
    "changes for the user to review/merge, or remove to discard).",
  capability: "write",
  approval: "suggest",
  shouldDefer: true,
  schema: z.object({
    name: z.string().regex(NAME_RE, "只能含字母数字点下划线短横,最长 64 字符").optional()
      .describe("worktree 名字(用作目录名和分支后缀);省略则随机生成"),
  }),
  handler: async (args, ctx) => {
    if (ctx.activeWorktree) {
      return `已经在 worktree 会话里(${ctx.activeWorktree.root}),先用 ExitWorktree 退出当前的,再进新的。`;
    }
    if (!ctx.createWorktree) {
      return "当前环境不支持 worktree。";
    }
    const id = args.name ?? randomId();
    const wt = ctx.createWorktree(id);
    if (!wt) {
      return "创建 worktree 失败(当前目录不是 git 仓库,或 git worktree add 执行出错)。";
    }
    const previousCwd = ctx.cwd;
    ctx.activeWorktree = { root: wt.root, branch: wt.branch, cleanup: wt.cleanup, hasChanges: wt.hasChanges, hasUnpushedCommits: wt.hasUnpushedCommits, previousCwd };
    ctx.cwd = wt.root;
    return `已进入 worktree:${wt.root}(分支 ${wt.branch})。文件读写/Bash/verify 现在都在这个目录下进行;` +
      `项目身份(memory/MCP/LSP/skills)仍指向原项目。做完用 ExitWorktree 离开。`;
  },
});
