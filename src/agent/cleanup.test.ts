import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { cleanup, maybeCleanup } from "./cleanup.js";
import { createWorktree } from "./worktree.js";

let root: string;
const NOW = 1_900_000_000_000; // 固定时间戳(避免依赖 Date.now)
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "dao-clean-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function mk(rel: string, ageDays: number) {
  const p = path.join(root, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, "x");
  const t = (NOW - ageDays * 86_400_000) / 1000;
  await fs.utimes(p, t, t);
}

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, stdio: "ignore" });
async function age(p: string, ageDays: number) {
  const t = (NOW - ageDays * 86_400_000) / 1000;
  await fs.utimes(p, t, t);
}

describe("cleanup", () => {
  it("删过期的 spill/subagents/sessions,保留近期", async () => {
    await mk(".dao/spill/old.txt", 40);
    await mk(".dao/spill/new.txt", 1);
    await mk(".dao/subagents/old.md", 40);
    await mk(".dao/sessions/old-sess/state.json", 40);
    const r = await cleanup(root, 30, NOW);
    expect(r.spill).toBe(1);
    expect(existsSync(path.join(root, ".dao/spill/old.txt"))).toBe(false);
    expect(existsSync(path.join(root, ".dao/spill/new.txt"))).toBe(true); // 近期保留
    expect(existsSync(path.join(root, ".dao/subagents/old.md"))).toBe(false);
    expect(existsSync(path.join(root, ".dao/sessions/old-sess"))).toBe(false);
  });

  it("maybeCleanup 节流:24h 内只清一次", async () => {
    await mk(".dao/spill/old.txt", 40);
    await maybeCleanup(root, NOW); // 第一次:清
    expect(existsSync(path.join(root, ".dao/spill/old.txt"))).toBe(false);
    await mk(".dao/spill/old2.txt", 40);
    await maybeCleanup(root, NOW + 3_600_000); // 1h 后:节流跳过
    expect(existsSync(path.join(root, ".dao/spill/old2.txt"))).toBe(true);
    await maybeCleanup(root, NOW + 2 * 86_400_000); // 2 天后:再清
    expect(existsSync(path.join(root, ".dao/spill/old2.txt"))).toBe(false);
  });

  it("DAO_NO_CLEANUP=1 → 不清", async () => {
    process.env.DAO_NO_CLEANUP = "1";
    await mk(".dao/spill/old.txt", 40);
    await maybeCleanup(root, NOW);
    expect(existsSync(path.join(root, ".dao/spill/old.txt"))).toBe(true);
    delete process.env.DAO_NO_CLEANUP;
  });

  // ---- 孤儿 worktree 回收(崩溃会话/EnterWorktree 忘了 ExitWorktree 留下的) ----
  describe("孤儿 worktree 回收", () => {
    beforeEach(() => {
      git(["init"], root);
      git(["config", "user.email", "t@t"], root);
      git(["config", "user.name", "t"], root);
      writeFileSync(path.join(root, "a.txt"), "hi");
      git(["add", "."], root);
      git(["commit", "-m", "init"], root);
    });

    it("过期且干净(无改动、分支已完全合并)→ 目录和分支都回收", async () => {
      const wt = createWorktree(root, "clean1")!;
      await age(wt.root, 40);
      const r = await cleanup(root, 30, NOW);
      expect(r.worktreesReclaimed).toBe(1);
      expect(existsSync(wt.root)).toBe(false);
      expect(execFileSync("git", ["branch", "--list", wt.branch], { cwd: root, encoding: "utf8" }).trim()).toBe("");
    });

    it("过期但有未提交改动 → 不回收,目录和分支都留着", async () => {
      const wt = createWorktree(root, "dirty1")!;
      writeFileSync(path.join(wt.root, "b.txt"), "uncommitted");
      await age(wt.root, 40);
      const r = await cleanup(root, 30, NOW);
      expect(r.worktreesReclaimed).toBe(0);
      expect(existsSync(wt.root)).toBe(true);
    });

    it("过期但有已提交、未合并回主分支的改动 → 目录可以删(工作区本身干净),但分支保留不强删", async () => {
      const wt = createWorktree(root, "committed1")!;
      writeFileSync(path.join(wt.root, "b.txt"), "committed work");
      git(["add", "."], wt.root);
      git(["commit", "-m", "isolated work"], wt.root);
      await age(wt.root, 40);
      await cleanup(root, 30, NOW);
      expect(existsSync(wt.root)).toBe(false); // worktree 目录本身没有未提交改动,可以安全 remove
      // 分支还在(git branch -d 对未合并分支会拒绝,不强删,保留可恢复)
      expect(execFileSync("git", ["branch", "--list", wt.branch], { cwd: root, encoding: "utf8" }).trim()).not.toBe("");
    });

    it("还没过期(近期)→ 不管干不干净都不动", async () => {
      const wt = createWorktree(root, "recent1")!;
      await age(wt.root, 1); // NOW 是固定的未来时间戳,真实 mtime 相对它总是"很老"——显式对齐成"近期"
      const r = await cleanup(root, 30, NOW);
      expect(r.worktreesReclaimed).toBe(0);
      expect(existsSync(wt.root)).toBe(true);
    });
  });
});
