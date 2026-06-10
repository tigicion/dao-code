import { execFileSync } from "node:child_process";
import path from "node:path";

// git worktree 隔离:让需要改文件的并行子代理各自在独立工作树+分支里干活,互不冲突。
// 改动留在各自分支,用户/agent 可事后 review/merge。需工作区是 git 仓库;否则返回 null(回退共享)。

export interface Worktree {
  root: string;
  branch: string;
  cleanup: () => void; // 移除 worktree + 删分支(改动会丢,仅在确认无需保留时调用)
}

export function createWorktree(repoRoot: string, id: string): Worktree | null {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoRoot, stdio: "ignore" });
  } catch {
    return null; // 不是 git 仓库
  }
  const branch = `dao-wt-${id}`;
  const root = path.join(repoRoot, ".dao", "worktrees", id);
  try {
    execFileSync("git", ["worktree", "add", "-b", branch, root, "HEAD"], { cwd: repoRoot, stdio: "ignore" });
  } catch {
    return null;
  }
  return {
    root,
    branch,
    cleanup: () => {
      try {
        execFileSync("git", ["worktree", "remove", "--force", root], { cwd: repoRoot, stdio: "ignore" });
        execFileSync("git", ["branch", "-D", branch], { cwd: repoRoot, stdio: "ignore" });
      } catch {
        /* 忽略 */
      }
    },
  };
}
