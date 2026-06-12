import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { multiEditTool } from "./multi_edit.js";

let root: string, abs: string;
const ctx = () => ({ workspaceRoot: root, readFiles: new Set([abs]) });
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "dao-multiedit-")); abs = path.join(root, "f.txt"); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("multi_edit", () => {
  it("按顺序应用多处替换", async () => {
    await fs.writeFile(abs, "A B C", "utf8");
    const out = await multiEditTool.handler({ path: "f.txt", edits: [
      { old_string: "A", new_string: "X" },
      { old_string: "C", new_string: "Z" },
    ] }, ctx());
    expect(out).toContain("2 组替换");
    expect(await fs.readFile(abs, "utf8")).toBe("X B Z");
  });

  it("任一处失败 → 整体不写盘(原子)", async () => {
    await fs.writeFile(abs, "A B C", "utf8");
    await expect(multiEditTool.handler({ path: "f.txt", edits: [
      { old_string: "A", new_string: "X" },
      { old_string: "不存在", new_string: "Z" },
    ] }, ctx())).rejects.toThrow(/未找到/);
    expect(await fs.readFile(abs, "utf8")).toBe("A B C"); // 未改
  });

  it("不唯一且无 replace_all → 报错且整体不改", async () => {
    await fs.writeFile(abs, "x x", "utf8");
    await expect(multiEditTool.handler({ path: "f.txt", edits: [{ old_string: "x", new_string: "y" }] }, ctx()))
      .rejects.toThrow(/不唯一/);
    expect(await fs.readFile(abs, "utf8")).toBe("x x");
  });
});
