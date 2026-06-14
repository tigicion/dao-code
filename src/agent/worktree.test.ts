import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorktree } from "./worktree.js";

let repo: string;
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, stdio: "ignore" });

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "dao-wt-"));
  git(["init"], repo);
  git(["config", "user.email", "t@t"], repo);
  git(["config", "user.name", "t"], repo);
  writeFileSync(path.join(repo, "a.txt"), "hi");
  git(["add", "."], repo);
  git(["commit", "-m", "init"], repo);
});
afterEach(async () => { await fs.rm(repo, { recursive: true, force: true }); });

describe("createWorktree", () => {
  it("非 git 目录 → null", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dao-nogit-"));
    expect(createWorktree(tmp, "x")).toBeNull();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("建 worktree;hasChanges 反映工作树状态;cleanup 移除", () => {
    const wt = createWorktree(repo, "t1")!;
    expect(wt).not.toBeNull();
    expect(existsSync(wt.root)).toBe(true);
    expect(wt.hasChanges()).toBe(false); // 刚建,无改动
    writeFileSync(path.join(wt.root, "b.txt"), "new");
    expect(wt.hasChanges()).toBe(true); // 有未提交改动
    wt.cleanup();
    expect(existsSync(wt.root)).toBe(false); // 已移除
  });
});
