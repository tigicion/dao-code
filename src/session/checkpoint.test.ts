import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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
