import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolContext } from "./types.js";
import { createWorktree } from "../agent/worktree.js";
import { enterWorktreeTool } from "./enter_worktree.js";
import { exitWorktreeTool } from "./exit_worktree.js";

let repo: string;
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, stdio: "ignore" });

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "dao-xwt-"));
  git(["init"], repo);
  git(["config", "user.email", "t@t"], repo);
  git(["config", "user.name", "t"], repo);
  writeFileSync(path.join(repo, "a.txt"), "hi");
  git(["add", "."], repo);
  git(["commit", "-m", "init"], repo);
});
afterEach(async () => { await fs.rm(repo, { recursive: true, force: true }); });

function makeCtx(): ToolContext {
  return { workspaceRoot: repo, createWorktree: (id: string) => createWorktree(repo, id) };
}

describe("ExitWorktree", () => {
  it("不在 worktree 会话里时是 no-op", async () => {
    const ctx = makeCtx();
    const out = await exitWorktreeTool.handler({ action: "keep" }, ctx);
    expect(out).toContain("不在 worktree");
    expect(ctx.cwd).toBeUndefined();
  });

  it("action=keep:目录保留,ctx.cwd 恢复到进入前", async () => {
    const ctx = makeCtx();
    await enterWorktreeTool.handler({}, ctx);
    const wtRoot = ctx.cwd!;
    const out = await exitWorktreeTool.handler({ action: "keep" }, ctx);
    expect(out).toContain("保留");
    expect(existsSync(wtRoot)).toBe(true);
    expect(ctx.cwd).toBeUndefined(); // 回到默认(等于 workspaceRoot)
    expect(ctx.activeWorktree).toBeUndefined();
  });

  it("action=remove 且有未提交改动、未传 discard_changes → 拒绝并列出改动", async () => {
    const ctx = makeCtx();
    await enterWorktreeTool.handler({}, ctx);
    const wtRoot = ctx.cwd!;
    writeFileSync(path.join(wtRoot, "b.txt"), "new");
    const out = await exitWorktreeTool.handler({ action: "remove" }, ctx);
    expect(out).toContain("discard_changes");
    expect(existsSync(wtRoot)).toBe(true); // 没被删
    expect(ctx.activeWorktree).toBeDefined(); // 仍在 worktree 会话里
  });

  it("action=remove + discard_changes:true → 移除目录和分支", async () => {
    const ctx = makeCtx();
    await enterWorktreeTool.handler({}, ctx);
    const wtRoot = ctx.cwd!;
    writeFileSync(path.join(wtRoot, "b.txt"), "new");
    const out = await exitWorktreeTool.handler({ action: "remove", discard_changes: true }, ctx);
    expect(out).toContain("移除");
    expect(existsSync(wtRoot)).toBe(false);
    expect(ctx.cwd).toBeUndefined();
  });

  it("action=remove:worktree 里已提交、工作区干净(git status 看不出改动),但有原分支没有的提交 → 仍要拒绝", async () => {
    // 这是本轮要补的缺口:旧实现只查 git status --porcelain,提交完的东西看起来"干净",
    // 会被当成"无改动"直接放行删除——已提交的工作就这么无声丢了。
    const ctx = makeCtx();
    await enterWorktreeTool.handler({}, ctx);
    const wtRoot = ctx.cwd!;
    writeFileSync(path.join(wtRoot, "b.txt"), "new");
    git(["add", "."], wtRoot);
    git(["commit", "-m", "work done in worktree"], wtRoot);
    const out = await exitWorktreeTool.handler({ action: "remove" }, ctx);
    expect(out).toContain("discard_changes");
    expect(existsSync(wtRoot)).toBe(true); // 没被删
    expect(ctx.activeWorktree).toBeDefined(); // 仍在 worktree 会话里
  });
});
