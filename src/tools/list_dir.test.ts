import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listDirTool } from "./list_dir.js";

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codeds-listdir-"));
  await fs.writeFile(path.join(root, "file.txt"), "x", "utf8");
  await fs.mkdir(path.join(root, "sub"));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("list_dir tool", () => {
  it("lists entries with a trailing slash on directories, sorted", async () => {
    const out = await listDirTool.handler({}, { workspaceRoot: root });
    expect(out).toBe("file.txt\nsub/");
  });

  it("lists a subdirectory by relative path", async () => {
    const out = await listDirTool.handler({ path: "sub" }, { workspaceRoot: root });
    expect(out).toBe("(空目录)");
  });

  it("throws when the directory is missing", async () => {
    await expect(listDirTool.handler({ path: "nope" }, { workspaceRoot: root })).rejects.toThrow();
  });

  it("declares read capability and auto approval", () => {
    expect(listDirTool.capability).toBe("read");
    expect(listDirTool.approval).toBe("auto");
    expect(listDirTool.name).toBe("list_dir");
  });

  it("工作区外路径:未授权返回 Error(不再硬抛)", async () => {
    const out = await listDirTool.handler({ path: ".." }, { workspaceRoot: root });
    expect(out).toContain("工作区之外");
  });

  it("工作区外路径:授权后可列", async () => {
    const out = await listDirTool.handler({ path: ".." }, { workspaceRoot: root, approveExternalRead: async () => true });
    expect(out).not.toContain("工作区之外"); // 列出了父目录内容
  });
});
