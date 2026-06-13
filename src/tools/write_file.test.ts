import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileTool } from "./write_file.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "dao-writefile-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("write_file tool", () => {
  it("creates a new file (no read required)", async () => {
    const out = await writeFileTool.handler(
      { path: "new.txt", content: "hello\nworld" },
      { workspaceRoot: root, readFiles: new Set() },
    );
    expect(out).toContain("已写入");
    expect(await fs.readFile(path.join(root, "new.txt"), "utf8")).toBe("hello\nworld");
  });

  it("creates parent directories as needed", async () => {
    await writeFileTool.handler(
      { path: "a/b/c.txt", content: "x" },
      { workspaceRoot: root, readFiles: new Set() },
    );
    expect(await fs.readFile(path.join(root, "a/b/c.txt"), "utf8")).toBe("x");
  });

  it("refuses to overwrite an existing file that was not read", async () => {
    await fs.writeFile(path.join(root, "exists.txt"), "old", "utf8");
    await expect(
      writeFileTool.handler({ path: "exists.txt", content: "new" }, { workspaceRoot: root, readFiles: new Set() }),
    ).rejects.toThrow(/先用 read_file/);
  });

  it("overwrites an existing file once it has been read", async () => {
    const abs = path.join(root, "exists.txt");
    await fs.writeFile(abs, "old", "utf8");
    await writeFileTool.handler(
      { path: "exists.txt", content: "new" },
      { workspaceRoot: root, readFiles: new Set([abs]) },
    );
    expect(await fs.readFile(abs, "utf8")).toBe("new");
  });

  it("工作区外路径:无授权回调 → 拒绝写入", async () => {
    await expect(
      writeFileTool.handler({ path: "../evil.txt", content: "x" }, { workspaceRoot: root, readFiles: new Set() }),
    ).rejects.toThrow(/未获授权写入/);
  });

  it("工作区外路径:授权回调放行 → 可写", async () => {
    const extName = `../${path.basename(root)}-ext.txt`; // 唯一的区外新文件,不会预先存在
    const out = await writeFileTool.handler(
      { path: extName, content: "ok" },
      { workspaceRoot: root, readFiles: new Set(), approveExternalWrite: async () => true },
    );
    expect(out).not.toMatch(/未获授权/);
    await fs.rm(path.resolve(root, extName), { force: true });
  });

  it("declares write capability and required approval", () => {
    expect(writeFileTool.capability).toBe("write");
    expect(writeFileTool.approval).toBe("required");
    expect(writeFileTool.name).toBe("write_file");
  });
});
