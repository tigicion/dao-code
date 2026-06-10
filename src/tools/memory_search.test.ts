import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { memorySearchTool } from "./memory_search.js";
import { writeMemory } from "./../memory/store.js";
import { newMemory } from "./../memory/types.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "dao-memsearch-"));
  mkdirSync(path.join(root, ".codeds", "memory"), { recursive: true });
});

const add = async (text: string) => {
  await writeMemory(path.join(root, ".codeds", "memory"), newMemory({ name: text.slice(0, 8), text, type: "user", today: "2026-06-09" }));
};

describe("memory_search", () => {
  it("无记忆 → 提示", async () => {
    const out = await memorySearchTool.handler({ query: "x" }, { workspaceRoot: root, homeDir: root });
    expect(out).toContain("暂无记忆");
  });

  it("按相关度返回命中", async () => {
    await add("用户在做 deepseek-v4-pro coding agent");
    await add("用户喜欢简洁回复");
    const out = await memorySearchTool.handler({ query: "deepseek agent" }, { workspaceRoot: root, homeDir: root });
    expect(out).toContain("deepseek-v4-pro");
  });

  it("无相关 → 明确提示", async () => {
    await add("用户喜欢简洁回复");
    const out = await memorySearchTool.handler({ query: "完全无关的量子物理" }, { workspaceRoot: root, homeDir: root });
    expect(out).toContain("无相关记忆");
  });
});
