import { z } from "zod";
import { execFileSync } from "node:child_process";
import { defineTool } from "./types.js";

function changesSummary(root: string): string {
  try {
    return execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export const exitWorktreeTool = defineTool({
  name: "exit_worktree",
  description: "退出 enter_worktree 建的 worktree 会话,把路径解析根目录切回进入前的状态。不在 worktree 会话里时" +
    "调用是空操作,不会报错也不会误删任何东西。action=keep 保留 worktree 目录和分支(改动留着,之后用户可以" +
    "自己 review/合并/删除);action=remove 直接删掉 worktree 目录和分支——但如果里面有未提交的改动或不在原分支上的" +
    "提交,会拒绝执行并列出这些改动,除非显式传 discard_changes:true(丢弃改动不可恢复,务必先确认用户确实不需要)。",
  descriptionEn: "Exits the worktree session started by enter_worktree, restoring the path-resolution root to what it was before entering. Calling " +
    "this when not in a worktree session is a no-op — no error, nothing deleted. action=keep leaves the worktree directory and branch on disk " +
    "(changes stay, the user can review/merge/delete later); action=remove deletes both — but if there are uncommitted changes or commits not on " +
    "the original branch, it refuses and lists them unless discard_changes:true is explicitly passed (irreversible — confirm with the user first).",
  capability: "write",
  approval: "suggest",
  shouldDefer: true,
  schema: z.object({
    action: z.enum(["keep", "remove"]).describe("keep=保留目录和分支;remove=删除目录和分支"),
    discard_changes: z.boolean().optional().describe("action=remove 且有未提交改动时,传 true 才会真正丢弃并删除"),
  }),
  handler: async (args, ctx) => {
    const wt = ctx.activeWorktree;
    if (!wt) return "当前不在 worktree 会话里,无需退出。";

    if (args.action === "remove") {
      const changes = changesSummary(wt.root);
      if (changes && !args.discard_changes) {
        return `该 worktree 有未提交的改动,直接删除会丢失:\n${changes}\n\n` +
          `确认要丢弃就带上 discard_changes:true 重新调用;想保留就用 action:'keep'。`;
      }
      wt.cleanup();
    }

    ctx.cwd = wt.previousCwd;
    ctx.activeWorktree = undefined;
    return args.action === "remove"
      ? `已移除 worktree(${wt.root})并删除分支 ${wt.branch},回到原目录。`
      : `worktree 保留在磁盘上(分支 ${wt.branch},目录 ${wt.root}),已退出会话回到原目录。`;
  },
});
