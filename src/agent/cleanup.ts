import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

// P2-58/67 卫生清理:启动时(节流到每日一次、非阻塞)清掉 .dao 下的过期临时产物,
// 防长期使用堆积。只动 .dao 内的可再生/历史产物,绝不碰用户文件。DAO_NO_CLEANUP=1 关闭。
const DAY = 86_400_000;

async function rmOlderThan(dir: string, cutoff: number): Promise<number> {
  let n = 0;
  let entries: string[];
  try { entries = await fs.readdir(dir); } catch { return 0; }
  for (const name of entries) {
    const p = path.join(dir, name);
    try {
      const st = await fs.stat(p);
      if (st.mtimeMs < cutoff) { await fs.rm(p, { recursive: true, force: true }); n++; }
    } catch { /* 跳过 */ }
  }
  return n;
}

export interface CleanupResult { spill: number; subagents: number; sessions: number; worktreesPruned: boolean; worktreesReclaimed: number }

// 回收过期的孤儿 worktree(EnterWorktree 进去后崩溃/忘了 ExitWorktree 留下的)。
// 安全网完全交给 git 自己的两道内置检查,不重新发明:
// - `git worktree remove`(不带 --force)有未提交改动会拒绝 → 该条整体跳过,目录和分支都留着。
// - `git branch -d`(不是 -D)分支未完全合并会拒绝 → 目录已经删了(工作区本身是干净的,
//   删目录不丢东西),但分支保留不强删,commit 还在,用户能找回来。
// 这是无人值守的后台清理,任何"可能丢工作"的场景都不该自己判断,交给用户手动用 ExitWorktree 处理。
async function reclaimWorktrees(workspaceRoot: string, cutoff: number): Promise<number> {
  const dir = path.join(workspaceRoot, ".dao", "worktrees");
  let entries: string[];
  try { entries = await fs.readdir(dir); } catch { return 0; }
  let reclaimed = 0;
  for (const id of entries) {
    const wtRoot = path.join(dir, id);
    try {
      const st = await fs.stat(wtRoot);
      if (st.mtimeMs >= cutoff) continue; // 还不够老,留给用户自己处理
      execFileSync("git", ["worktree", "remove", wtRoot], { cwd: workspaceRoot, stdio: "ignore" });
      try { execFileSync("git", ["branch", "-d", `dao-wt-${id}`], { cwd: workspaceRoot, stdio: "ignore" }); } catch { /* 未合并,保留分支 */ }
      reclaimed++;
    } catch {
      /* 有未提交改动、或本身已不是有效 worktree → 跳过,不动它 */
    }
  }
  return reclaimed;
}

// 直接执行清理(测试可注入 now 与 days,绕过节流)。
export async function cleanup(workspaceRoot: string, days: number, now: number): Promise<CleanupResult> {
  const dao = path.join(workspaceRoot, ".dao");
  const cutoff = now - days * DAY;
  const spill = await rmOlderThan(path.join(dao, "spill"), cutoff);
  const subagents = await rmOlderThan(path.join(dao, "subagents"), cutoff);
  const sessions = await rmOlderThan(path.join(dao, "sessions"), cutoff);
  const worktreesReclaimed = await reclaimWorktrees(workspaceRoot, cutoff);
  let worktreesPruned = false;
  try { execFileSync("git", ["worktree", "prune"], { cwd: workspaceRoot, stdio: "ignore" }); worktreesPruned = true; } catch { /* 非 git 或无 */ }
  return { spill, subagents, sessions, worktreesPruned, worktreesReclaimed };
}

// 启动调用:节流到每日一次(.dao/.last-cleanup 时间戳),非阻塞、best-effort、绝不抛。
export async function maybeCleanup(workspaceRoot: string, now: number = Date.now()): Promise<void> {
  if (process.env.DAO_NO_CLEANUP === "1") return;
  const stamp = path.join(workspaceRoot, ".dao", ".last-cleanup");
  try {
    const last = Number(await fs.readFile(stamp, "utf8").catch(() => "0"));
    if (now - last < DAY) return; // 24h 内已清,跳过
    await fs.mkdir(path.dirname(stamp), { recursive: true });
    await fs.writeFile(stamp, String(now), "utf8");
    const days = Number(process.env.DAO_CLEANUP_DAYS) || 30;
    await cleanup(workspaceRoot, days, now);
  } catch { /* 清理失败绝不影响启动 */ }
}
