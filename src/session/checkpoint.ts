import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// 影子 git:用独立的 git 目录(.dao/shadow.git)对工作区做快照/回滚,
// 完全不碰用户自己的 .git、不改用户提交历史。每个回合前后 snapshot 一个点,/restore 回退文件。
// add -A 会自动尊重工作区的 .gitignore(node_modules/.dao 等已被排除)。

export interface Checkpointer {
  enabled: boolean;
  snapshot(label: string): string | null; // 返回 commit sha;失败/未启用返回 null
  restore(ref: string): boolean; // 把工作区文件回退到该快照(reset --hard)
  list(limit?: number): { ref: string; label: string; ts: string }[];
}

const noop: Checkpointer = { enabled: false, snapshot: () => null, restore: () => false, list: () => [] };

export function createCheckpointer(workspaceRoot: string): Checkpointer {
  const gitDir = path.join(workspaceRoot, ".dao", "shadow.git");
  const run = (args: string[], opts: { gitOnly?: boolean } = {}) =>
    execFileSync("git", ["--git-dir", gitDir, ...args], {
      cwd: workspaceRoot,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
  try {
    if (!existsSync(gitDir)) {
      mkdirSync(gitDir, { recursive: true });
      execFileSync("git", ["init", "--bare", gitDir], { stdio: "ignore" });
      // 让它带外置 worktree 工作(非 bare),指向工作区根;并设身份避免 commit 失败。
      run(["config", "core.bare", "false"]);
      run(["config", "core.worktree", workspaceRoot]);
      run(["config", "user.email", "dao@local"]);
      run(["config", "user.name", "DAO CODE"]);
      mkdirSync(path.join(gitDir, "info"), { recursive: true });
      writeFileSync(
        path.join(gitDir, "info", "exclude"),
        ["node_modules/", ".git/", ".dao/", ".codeds/", "dist/", "dist-bin/", "*.log", ""].join("\n"),
      );
    }
  } catch {
    return noop; // 无 git / 初始化失败 → 优雅降级,不影响主流程
  }
  return {
    enabled: true,
    snapshot(label) {
      try {
        run(["add", "-A"]);
        run(["commit", "--allow-empty", "--no-verify", "-m", label]);
        return run(["rev-parse", "HEAD"]).trim();
      } catch {
        return null;
      }
    },
    restore(ref) {
      try {
        run(["reset", "--hard", ref]);
        return true;
      } catch {
        return false;
      }
    },
    list(limit = 30) {
      try {
        const out = run(["log", `--format=%H%x09%s%x09%cI`, `-${limit}`]);
        return out
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const [ref, label, ts] = l.split("\t");
            return { ref: ref ?? "", label: label ?? "", ts: ts ?? "" };
          });
      } catch {
        return [];
      }
    },
  };
}
