import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gatherEnvSnapshotData, formatEnvSnapshot } from "./env_snapshot.js";

let ws: string;
beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "dao-envsnap-"));
});
afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
});

describe("gatherEnvSnapshotData", () => {
  it("非 git 目录:探测到工具链,gitBranch/gitDirtyCount 为 null", async () => {
    const data = await gatherEnvSnapshotData(ws);
    expect(data).not.toBeNull();
    // 跑测试的机器本身就装了 node,这条必然探测到
    expect(data!.toolchain.some((l) => /node/i.test(l))).toBe(true);
    expect(data!.gitBranch).toBeNull();
    expect(data!.gitDirtyCount).toBeNull();
  });

  it("git 仓库(干净):探测到分支、脏文件数为 0", async () => {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
    execFileSync("git", ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"], { cwd: ws });

    const data = await gatherEnvSnapshotData(ws);
    expect(data).not.toBeNull();
    expect(data!.gitBranch).toBe("main");
    expect(data!.gitDirtyCount).toBe(0);
  });

  it("git 仓库(有未提交改动):脏文件数 > 0", async () => {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
    execFileSync("git", ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"], { cwd: ws });
    await fs.writeFile(path.join(ws, "untracked.txt"), "x");

    const data = await gatherEnvSnapshotData(ws);
    expect(data!.gitDirtyCount).toBe(1);
  });

  it("超时预算极小时静默返回 null(不抛出、不挂起)", async () => {
    const data = await gatherEnvSnapshotData(ws, 1);
    expect(data).toBeNull();
  });

  it("不存在的目录:静默返回 null,不抛出", async () => {
    const data = await gatherEnvSnapshotData(path.join(ws, "does-not-exist"));
    expect(data).toBeNull();
  });
});

describe("formatEnvSnapshot", () => {
  it("null 输入 → 空串", () => {
    expect(formatEnvSnapshot(null, false)).toBe("");
  });

  it("zh:格式化工具链 + 干净分支", () => {
    const out = formatEnvSnapshot(
      { toolchain: ["node v20.0.0"], gitBranch: "master", gitDirtyCount: 0 },
      false,
    );
    expect(out).toContain("可用语言/工具: node v20.0.0");
    expect(out).toContain("Git 分支: master (干净)");
  });

  it("zh:脏分支显示改动数", () => {
    const out = formatEnvSnapshot({ toolchain: [], gitBranch: "master", gitDirtyCount: 3 }, false);
    expect(out).toContain("3 个未提交改动");
  });

  it("en:格式化工具链 + branch", () => {
    const out = formatEnvSnapshot(
      { toolchain: ["node v20.0.0"], gitBranch: "master", gitDirtyCount: 0 },
      true,
    );
    expect(out).toContain("Available languages/tools: node v20.0.0");
    expect(out).toContain("Git branch: master (clean)");
  });

  it("既无工具链也无分支 → 空串", () => {
    expect(formatEnvSnapshot({ toolchain: [], gitBranch: null, gitDirtyCount: null }, false)).toBe("");
  });
});
