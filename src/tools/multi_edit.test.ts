import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { multiEditTool } from "./multi_edit.js";

let root: string, abs: string;
const ctx = () => ({ workspaceRoot: root, readFiles: new Set([abs]) });
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "dao-multiedit-")); abs = path.join(root, "f.txt"); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("MultiEdit", () => {
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

  it("old_string 因全角/半角标点写岔而找不到时,报错附带具体字符diff", async () => {
    await fs.writeFile(abs, "A 免一次审批——下一步", "utf8");
    await expect(multiEditTool.handler({ path: "f.txt", edits: [
      { old_string: "A", new_string: "X" },
      { old_string: "免一次审批--下一步", new_string: "y" },
    ] }, ctx())).rejects.toThrow(/U\+002D.*U\+2014/s);
    expect(await fs.readFile(abs, "utf8")).toBe("A 免一次审批——下一步"); // 原子:未改
  });
});
