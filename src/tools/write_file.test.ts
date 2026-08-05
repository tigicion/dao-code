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

describe("Write tool", () => {
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
    ).rejects.toThrow(/先用 Read/);
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

  it("第二次整篇重写同一路径、中间没有任何 exec_shell 调用 → 拒绝(真实撞见:write-compressor 复测里模型写完 compress.rs 从未编译运行过就整篇重写)", async () => {
    const abs = path.join(root, "compress.rs");
    await fs.writeFile(abs, "old", "utf8");
    const pendingUnverifiedWrites = new Set<string>();
    // 第一次"写入"(模拟已经写过一版):readFiles 满足覆盖前置条件,同时把它标记为待验证。
    await writeFileTool.handler({ path: "compress.rs", content: "v1" }, { workspaceRoot: root, readFiles: new Set([abs]), pendingUnverifiedWrites });
    expect(pendingUnverifiedWrites.has(abs)).toBe(true);
    // 第二次整篇重写,中间没有任何 exec_shell 调用清空过这个集合 → 拒绝。
    await expect(
      writeFileTool.handler({ path: "compress.rs", content: "v2 rewritten from scratch" }, { workspaceRoot: root, readFiles: new Set([abs]), pendingUnverifiedWrites }),
    ).rejects.toThrow(/拒绝写入.*compress\.rs.*没有执行过任何命令/s);
    // 拒绝时不应该真的把内容改成 v2。
    expect(await fs.readFile(abs, "utf8")).toBe("v1");
  });

  it("第二次整篇重写同一路径、中间有过 exec_shell 调用(集合被清空) → 允许", async () => {
    const abs = path.join(root, "compress.rs");
    await fs.writeFile(abs, "old", "utf8");
    const pendingUnverifiedWrites = new Set<string>();
    await writeFileTool.handler({ path: "compress.rs", content: "v1" }, { workspaceRoot: root, readFiles: new Set([abs]), pendingUnverifiedWrites });
    pendingUnverifiedWrites.clear(); // 模拟中间发生过一次 exec_shell 调用
    await writeFileTool.handler({ path: "compress.rs", content: "v2 rewritten after running v1" }, { workspaceRoot: root, readFiles: new Set([abs]), pendingUnverifiedWrites });
    expect(await fs.readFile(abs, "utf8")).toBe("v2 rewritten after running v1");
  });

  it("不传 pendingUnverifiedWrites(如测试桩/未接入场景)时不受此限制,行为保持不变", async () => {
    const abs = path.join(root, "compress.rs");
    await fs.writeFile(abs, "old", "utf8");
    await writeFileTool.handler({ path: "compress.rs", content: "v1" }, { workspaceRoot: root, readFiles: new Set([abs]) });
    await writeFileTool.handler({ path: "compress.rs", content: "v2" }, { workspaceRoot: root, readFiles: new Set([abs]) });
    expect(await fs.readFile(abs, "utf8")).toBe("v2");
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
    expect(writeFileTool.name).toBe("Write");
  });
});
