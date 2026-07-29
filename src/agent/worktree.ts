import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// git worktree 隔离:让需要改文件的并行子代理各自在独立工作树+分支里干活,互不冲突。
// 改动留在各自分支,用户/agent 可事后 review/merge。需工作区是 git 仓库;否则返回 null(回退共享)。

// worktree 落在 <repoRoot>/.dao/worktrees/<id>,嵌套在被操作项目自己的工作树内部——只有项目
// 自己的 .gitignore 排除了 .dao/,这个目录才不会作为未跟踪内容出现在项目自己的 git status 里
// (否则用户一次 `git add -A` 就会把整个 worktree 的文件吸进主仓库的暂存区)。dao-code 自己的仓库
// 已经这么配了,但被操作的目标项目未必,所以在这里补一份,幂等、只追加不覆盖已有内容。
function ensureDaoGitignored(repoRoot: string): void {
  const gitignorePath = path.join(repoRoot, ".gitignore");
  try {
    const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
    if (existing.split("\n").some((l) => /^\/?\.dao\/?$/.test(l.trim()))) return; // 已经排除过
    const sep = existing.length && !existing.endsWith("\n") ? "\n" : "";
    writeFileSync(gitignorePath, `${existing}${sep}.dao/\n`);
  } catch {
    /* 没权限/只读文件系统等 → 不阻塞 worktree 创建,只是少了这层保护 */
  }
}

export interface Worktree {
  root: string;
  branch: string;
  cleanup: () => void; // 移除 worktree + 删分支(改动会丢,仅在确认无需保留时调用)
  hasChanges: () => boolean; // 工作树是否有未提交改动(判断该保留还是清理)
  // 分支上是否有 baseSha(建 worktree 那一刻的 HEAD)之后的提交——工作树里提交过东西后
  // hasChanges() 会变回 false(工作区干净),但那些提交仍然只活在这个即将被删的分支上,
  // 光看工作区状态看不出来,得单独查。
  hasUnpushedCommits: () => boolean;
}

export function createWorktree(repoRoot: string, id: string): Worktree | null {
  let baseSha: string;
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoRoot, stdio: "ignore" });
    baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return null; // 不是 git 仓库
  }
  ensureDaoGitignored(repoRoot);
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
    hasChanges: () => {
      try {
        const out = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
        return out.trim().length > 0;
      } catch {
        return true; // 判断不了 → 保守保留(不误删)
      }
    },
    hasUnpushedCommits: () => {
      try {
        const out = execFileSync("git", ["log", `${baseSha}..HEAD`, "--oneline"], { cwd: root, encoding: "utf8" });
        return out.trim().length > 0;
      } catch {
        return true; // 判断不了 → 保守保留(不误删)
      }
    },
  };
}
