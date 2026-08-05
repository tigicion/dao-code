import { z } from "zod";
import { defineTool } from "./types.js";

export const exitWorktreeTool = defineTool({
  name: "ExitWorktree",
  description: "退出 EnterWorktree 建的 worktree 会话,把路径解析根目录切回进入前的状态。不在 worktree 会话里时" +
    "调用是空操作,不会报错也不会误删任何东西。action=keep 保留 worktree 目录和分支(改动留着,之后用户可以" +
    "自己 review/合并/删除);action=remove 直接删掉 worktree 目录和分支——但如果里面有未提交的改动或不在原分支上的" +
    "提交,会拒绝执行并列出这些改动,除非显式传 discard_changes:true(丢弃改动不可恢复,务必先确认用户确实不需要)。",
  descriptionEn: "Exits the worktree session started by EnterWorktree, restoring the path-resolution root to what it was before entering. Calling " +
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
      // 两种都要查:未提交改动(hasChanges)只覆盖"改了但没 commit"的情况;worktree 里已经
      // commit 过、工作区变干净后 hasChanges 会误判成"无改动"——那些提交仍然只活在这个即将
      // 被删的分支上,得靠 hasUnpushedCommits 单独兜底,否则已提交的工作会被 cleanup() 的
      // git branch -D 无声丢弃。
      const uncommitted = wt.hasChanges();
      const uncommittedOnBranch = wt.hasUnpushedCommits();
      if ((uncommitted || uncommittedOnBranch) && !args.discard_changes) {
        const parts: string[] = [];
        if (uncommitted) parts.push("有未提交的改动");
        if (uncommittedOnBranch) parts.push("有已提交但不在原分支上的提交");
        return `该 worktree ${parts.join("、")},直接删除会丢失。\n` +
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
