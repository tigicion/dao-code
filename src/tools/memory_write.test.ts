import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { memoryWriteTool } from "./memory_write.js";
import { loadMemoryFile } from "../memory/store.js";

let root: string;
function ctx() {
  return { workspaceRoot: root };
}
function projFile() {
  return path.join(root, ".codeds", "memory", "memories.json");
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codeds-memwrite-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("memory_write tool", () => {
  it("records a project-scope memory", async () => {
    const out = await memoryWriteTool.handler({ text: "本项目用 vitest" }, ctx());
    expect(out).toContain("已记住");
    expect(out).toContain("项目级");
    expect(await loadMemoryFile(projFile())).toEqual([{ text: "本项目用 vitest" }]);
  });

  it("skips a duplicate", async () => {
    await memoryWriteTool.handler({ text: "fact" }, ctx());
    const out = await memoryWriteTool.handler({ text: "fact" }, ctx());
    expect(out).toContain("已存在");
    expect(await loadMemoryFile(projFile())).toHaveLength(1);
  });

  it("declares plan capability and auto approval", () => {
    expect(memoryWriteTool.capability).toBe("plan");
    expect(memoryWriteTool.approval).toBe("auto");
    expect(memoryWriteTool.name).toBe("memory_write");
  });
});
