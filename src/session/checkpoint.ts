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

// 排除重目录/大文件,避免 add -A 扫描/暂存它们(目录模式让 git 直接不下钻 → 提速最明显)。
const EXCLUDES = [
  "node_modules/", ".git/", ".dao/", ".codeds/",
  "dist/", "dist-bin/", "build/", "out/", "target/", "obj/", "bin/",
  ".next/", ".nuxt/", ".svelte-kit/", ".turbo/", ".cache/", "coverage/", ".parcel-cache/",
  ".venv/", "venv/", "env/", "__pycache__/", ".mypy_cache/", ".pytest_cache/", ".tox/", ".ruff_cache/",
  "vendor/", ".gradle/", ".idea/", "Pods/", "DerivedData/", ".terraform/",
  "*.log", "*.tmp", ".DS_Store",
  "*.zip", "*.tar", "*.gz", "*.tgz", "*.mp4", "*.mov", "*.iso", "*.dmg", "*.bin", "*.sqlite",
  "",
];

export function createCheckpointer(workspaceRoot: string): Checkpointer {
  if (process.env.DAO_NO_CHECKPOINT) return noop; // 显式关闭
  const daoDir = path.join(workspaceRoot, ".dao");
  // 防冲突:用户真实 git 不应把 .dao/(影子库/会话/导出)纳入版本管理。写一个忽略一切的 .gitignore
  // (含其自身),用户的 git 从此完全看不到 .dao。幂等。
  try {
    mkdirSync(daoDir, { recursive: true });
    if (!existsSync(path.join(daoDir, ".gitignore"))) writeFileSync(path.join(daoDir, ".gitignore"), "*\n");
  } catch {}
  const gitDir = path.join(daoDir, "shadow.git");
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
      run(["config", "gc.auto", "256"]); // 阈值调低 → 提交时自动打包松散对象,限制影子库膨胀
      mkdirSync(path.join(gitDir, "info"), { recursive: true });
      writeFileSync(path.join(gitDir, "info", "exclude"), EXCLUDES.join("\n"));
    }
  } catch {
    return noop; // 无 git / 初始化失败 → 优雅降级,不影响主流程
  }
  // 自适应慢检测:超大工作区里一次 add -A 很贵且阻塞回合。若某次快照超阈值,停止后续快照
  // (已存快照仍可 restore),避免每回合都卡。阈值可用 DAO_CHECKPOINT_MAX_MS 覆盖。
  const MAX_MS = Number(process.env.DAO_CHECKPOINT_MAX_MS) || 2500;
  let tooSlow = false;
  return {
    enabled: true,
    snapshot(label) {
      if (tooSlow) return null; // 工作区过大:已停止快照
      try {
        const t0 = Date.now();
        run(["add", "-A"]);
        run(["commit", "--allow-empty", "--no-verify", "-m", label]);
        const sha = run(["rev-parse", "HEAD"]).trim();
        if (Date.now() - t0 > MAX_MS) tooSlow = true; // 太慢 → 后续跳过
        return sha;
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
