import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWrite } from "./fs_atomic.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "dao-atomic-"));
});

describe("atomicWrite", () => {
  it("写入内容并自动建目录,不留临时文件", async () => {
    const p = path.join(root, "sub", "a.txt");
    await atomicWrite(p, "hello");
    expect(readFileSync(p, "utf8")).toBe("hello");
    expect(readdirSync(path.join(root, "sub")).filter((f) => f.includes(".tmp"))).toHaveLength(0);
  });

  it("覆盖已有文件", async () => {
    const p = path.join(root, "a.txt");
    await atomicWrite(p, "v1");
    await atomicWrite(p, "v2");
    expect(readFileSync(p, "utf8")).toBe("v2");
  });
});
