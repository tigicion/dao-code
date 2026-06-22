import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileTool } from "./read_file.js";

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "dao-readfile-"));
  await fs.writeFile(path.join(root, "a.txt"), "line1\nline2\nline3\n", "utf8");
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("read_file tool", () => {
  it("returns file content with 1-based line numbers", async () => {
    const out = await readFileTool.handler({ path: "a.txt" }, { workspaceRoot: root });
    expect(out).toContain("1\tline1");
    expect(out).toContain("2\tline2");
    expect(out).toContain("3\tline3");
  });

  it("honors offset and limit", async () => {
    const out = await readFileTool.handler({ path: "a.txt", offset: 2, limit: 1 }, { workspaceRoot: root });
    expect(out).toBe("2\tline2");
  });

  it("throws when the file is missing", async () => {
    await expect(
      readFileTool.handler({ path: "nope.txt" }, { workspaceRoot: root }),
    ).rejects.toThrow();
  });

  it("declares read capability and auto approval", () => {
    expect(readFileTool.capability).toBe("read");
    expect(readFileTool.approval).toBe("auto");
    expect(readFileTool.name).toBe("read_file");
  });

  it("工作区外路径:未授权返回 Error(不再硬抛)", async () => {
    const out = await readFileTool.handler({ path: "../escape.txt" }, { workspaceRoot: root });
    expect(out).toContain("工作区之外");
  });

  it("工作区外路径:授权后可读", async () => {
    await fs.writeFile(path.join(root, "..", "outside-read.txt"), "外部内容", "utf8");
    const out = await readFileTool.handler(
      { path: "../outside-read.txt" },
      { workspaceRoot: root, approveExternalRead: async () => true },
    );
    expect(out).toContain("外部内容");
  });

  it("records the read file's absolute path in ctx.readFiles", async () => {
    const seen = new Set<string>();
    await readFileTool.handler({ path: "a.txt" }, { workspaceRoot: root, readFiles: seen });
    expect(seen.has(path.join(root, "a.txt"))).toBe(true);
  });

  it("二进制文件(含 NUL)→ 返回 Error 不读乱码", async () => {
    await fs.writeFile(path.join(root, "bin.dat"), Buffer.from([0x41, 0x00, 0x42]));
    const out = await readFileTool.handler({ path: "bin.dat" }, { workspaceRoot: root });
    expect(out).toContain("二进制");
  });

  it("offset 超过总行数 → 明确提示", async () => {
    const out = await readFileTool.handler({ path: "a.txt", offset: 999 }, { workspaceRoot: root });
    expect(out).toContain("超过文件总行数");
  });

  it("不指定 limit 时默认只读前 2000 行 + 续读提示(防整读大文件爆上下文)", async () => {
    const big = Array.from({ length: 2500 }, (_, i) => `L${i + 1}`).join("\n");
    await fs.writeFile(path.join(root, "big.txt"), big, "utf8");
    const out = await readFileTool.handler({ path: "big.txt" }, { workspaceRoot: root });
    expect(out).toContain("2000\tL2000"); // 第 2000 行在
    expect(out).not.toContain("2001\tL2001"); // 第 2001 行被截断
    expect(out).toContain("文件共 2500 行"); // 续读提示给出总行数
    expect(out).toContain("offset=2001"); // 指明从哪续读
  });

  it("显式 limit 不受默认上限影响(可超 2000)", async () => {
    const out = await readFileTool.handler({ path: "big.txt", limit: 2300 }, { workspaceRoot: root });
    expect(out).toContain("2300\tL2300");
    expect(out).not.toContain("文件共 2500 行"); // 显式 limit 时不加默认截断提示
  });
});
