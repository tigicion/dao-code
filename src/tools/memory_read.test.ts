import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { memoryReadTool } from "./memory_read.js";
import { writeMemory } from "../memory/store.js";
import { newMemory } from "../memory/types.js";
import type { ToolContext } from "./types.js";

let root: string;
let home: string;
const ctx = (): ToolContext => ({ workspaceRoot: root, homeDir: home } as ToolContext);

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "dao-memread-ws-"));
  home = mkdtempSync(path.join(os.tmpdir(), "dao-memread-home-"));
});

describe("memory_read", () => {
  it("按名取回整句全文(项目级),含元信息,零模型", async () => {
    const dir = path.join(root, ".dao", "memory");
    await writeMemory(dir, newMemory({ name: "emoji-skLabelNode-显示问号", text: "emoji 用 SKLabelNode 会显示?,需 UIGraphicsImageRenderer", type: "procedural", today: "2026-06-18", importance: 8 }));
    const out = await memoryReadTool.handler({ name: "emoji-skLabelNode-显示问号" }, ctx());
    expect(out).toContain("UIGraphicsImageRenderer");
    expect(out).toContain("procedural");
  });

  it("部分匹配也能命中", async () => {
    const dir = path.join(home, ".dao", "memory");
    await writeMemory(dir, newMemory({ name: "用户偏好选项式引导", text: "用户偏好结构化选项,而非开放式提问", type: "user", today: "2026-06-18" }));
    const out = await memoryReadTool.handler({ name: "选项式" }, ctx());
    expect(out).toContain("结构化选项");
  });

  it("找不到 → 明确告知,不编造", async () => {
    const out = await memoryReadTool.handler({ name: "不存在的记忆" }, ctx());
    expect(out).toContain("未找到");
  });
});
