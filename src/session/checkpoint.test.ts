import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createCheckpointer } from "./checkpoint.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "dao-ckpt-"));
});

describe("createCheckpointer(影子 git)", () => {
  it("快照→改动→新快照→restore 回退(文件还原 + 新增文件移除)", () => {
    const a = path.join(root, "a.txt");
    writeFileSync(a, "v1");
    const cp = createCheckpointer(root);
    expect(cp.enabled).toBe(true);

    const ref1 = cp.snapshot("turn1");
    expect(ref1).toBeTruthy();

    writeFileSync(a, "v2");
    writeFileSync(path.join(root, "b.txt"), "new");
    cp.snapshot("turn2");
    expect(cp.list().length).toBeGreaterThanOrEqual(2); // restore 前有 2 个快照

    expect(cp.restore(ref1!)).toBe(true);
    expect(readFileSync(a, "utf8")).toBe("v1"); // 改动还原
    expect(existsSync(path.join(root, "b.txt"))).toBe(false); // turn2 新增文件被移除
  });

  it("不污染用户 .git(只用 .dao/shadow.git)", () => {
    const cp = createCheckpointer(root);
    cp.snapshot("x");
    expect(existsSync(path.join(root, ".git"))).toBe(false);
    expect(existsSync(path.join(root, ".dao", "shadow.git"))).toBe(true);
  });
});

// 复现:超大工作区(实测撞见 108GB、一堆 .rar/.exe/.xp3/.mpg 大文件目录)下 `git add -A`
// 首次快照要给每个文件算哈希,能卡到 6 分钟+。execFileSync 是真同步阻塞 Node 主线程,不是
// 网络 await,ESC/Ctrl-C 完全打不断——所以必须给 execFileSync 加硬超时,而不是靠事后统计的
// "太慢就跳过下一次"(那只保护后续快照,救不了正在卡着的这一次)。
describe("createCheckpointer 硬超时(git add 卡死场景不无限阻塞)", () => {
  let fakeBinDir: string;
  let originalPath: string | undefined;
  let originalTimeoutEnv: string | undefined;

  beforeEach(() => {
    fakeBinDir = mkdtempSync(path.join(os.tmpdir(), "dao-fakegit-"));
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    // 假 git:遇到 "add" 子命令就模拟"卡在给大文件算哈希"(睡 5s);其余子命令(init/config/commit/
    // rev-parse)透传给真 git,好让 createCheckpointer 的初始化流程正常走完。
    const script = `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "add" ]; then\n    sleep 5\n    exit 0\n  fi\ndone\nexec "${realGit}" "$@"\n`;
    const fakeGitPath = path.join(fakeBinDir, "git");
    writeFileSync(fakeGitPath, script);
    chmodSync(fakeGitPath, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = `${fakeBinDir}:${originalPath ?? ""}`;
    originalTimeoutEnv = process.env.DAO_CHECKPOINT_TIMEOUT_MS;
    process.env.DAO_CHECKPOINT_TIMEOUT_MS = "300"; // 硬超时 300ms,远小于假 git 的 5s "卡死"
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalTimeoutEnv === undefined) delete process.env.DAO_CHECKPOINT_TIMEOUT_MS;
    else process.env.DAO_CHECKPOINT_TIMEOUT_MS = originalTimeoutEnv;
  });

  it("git add -A 卡住时 snapshot 在硬超时内返回 null,不会傻等子进程跑完", () => {
    writeFileSync(path.join(root, "a.txt"), "v1");
    const cp = createCheckpointer(root);
    const t0 = Date.now();
    const ref = cp.snapshot("turn1");
    const elapsed = Date.now() - t0;
    expect(ref).toBeNull(); // 超时降级:不打快照,但不阻塞回合
    expect(elapsed).toBeLessThan(4000); // 远小于假 git 的 5s sleep,证明是超时生效而非等它跑完
  }, 10000);
});
