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

  it("工作区外路径:直接解析并写入(放行交给权限系统,工具不再硬拦)", async () => {
    const extName = `../${path.basename(root)}-ext.txt`; // 唯一的区外新文件
    const out = await writeFileTool.handler(
      { path: extName, content: "ok" },
      { workspaceRoot: root, readFiles: new Set() },
    );
    const abs = path.resolve(root, extName);
    expect(await fs.readFile(abs, "utf8")).toBe("ok");
    await fs.rm(abs, { force: true });
  });

  it("P2-23:文件自读后被外部改动 → 拒绝覆盖(防 clobber)", async () => {
    const abs = path.join(root, "exists.txt");
    await fs.writeFile(abs, "old", "utf8");
    const st = await fs.stat(abs);
    const readMeta = new Map([[abs, { mtime: st.mtimeMs - 1000, size: 999 }]]); // 模拟"读时元信息"与现状不符
    await expect(
      writeFileTool.handler({ path: "exists.txt", content: "new" }, { workspaceRoot: root, readFiles: new Set([abs]), readMeta }),
    ).rejects.toThrow(/已被外部改动/);
  });

  it("P2-23:元信息一致 → 正常覆盖", async () => {
    const abs = path.join(root, "exists.txt");
    await fs.writeFile(abs, "old", "utf8");
    const st = await fs.stat(abs);
    const readMeta = new Map([[abs, { mtime: st.mtimeMs, size: st.size }]]);
    await writeFileTool.handler({ path: "exists.txt", content: "new" }, { workspaceRoot: root, readFiles: new Set([abs]), readMeta });
    expect(await fs.readFile(abs, "utf8")).toBe("new");
  });

  it("declares write capability and required approval", () => {
    expect(writeFileTool.capability).toBe("write");
    expect(writeFileTool.approval).toBe("required");
    expect(writeFileTool.name).toBe("write_file");
  });
});
