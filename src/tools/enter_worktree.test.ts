import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolContext } from "./types.js";
import { createWorktree } from "../agent/worktree.js";
import { enterWorktreeTool } from "./enter_worktree.js";

let repo: string;
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, stdio: "ignore" });

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "dao-ewt-"));
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

describe("enter_worktree", () => {
  it("建 worktree 并把 ctx.cwd 切过去,workspaceRoot 不变", async () => {
    const ctx = makeCtx();
    const out = await enterWorktreeTool.handler({}, ctx);
    expect(out).toContain("worktree");
    expect(ctx.cwd).toBeDefined();
    expect(ctx.cwd).not.toBe(repo);
    expect(ctx.workspaceRoot).toBe(repo); // 项目身份不受影响
    expect(ctx.activeWorktree).toBeDefined();
  });

  it("已经在 worktree 会话里时不允许再进一个", async () => {
    const ctx = makeCtx();
    await enterWorktreeTool.handler({}, ctx);
    const out = await enterWorktreeTool.handler({}, ctx);
    expect(out).toContain("已经在 worktree");
  });

  it("不支持 worktree 的环境(如非 git 仓库)给出明确提示", async () => {
    const ctx: ToolContext = { workspaceRoot: repo, createWorktree: () => null };
    const out = await enterWorktreeTool.handler({}, ctx);
    expect(out).toContain("失败");
    expect(ctx.cwd).toBeUndefined();
  });
});
