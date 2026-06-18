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

describe("memory_read(按名或关键词查,吸收原 memory_search)", () => {
  it("精确名 → 回整句全文(项目级),含元信息,零模型", async () => {
    const dir = path.join(root, ".dao", "memory");
    await writeMemory(dir, newMemory({ name: "emoji-skLabelNode-显示问号", text: "emoji 用 SKLabelNode 会显示?,需 UIGraphicsImageRenderer", type: "procedural", today: "2026-06-18", importance: 8 }));
    const out = await memoryReadTool.handler({ query: "emoji-skLabelNode-显示问号" }, ctx());
    expect(out).toContain("UIGraphicsImageRenderer");
    expect(out).toContain("procedural");
  });

  it("名字部分匹配也能命中", async () => {
    const dir = path.join(home, ".dao", "memory");
    await writeMemory(dir, newMemory({ name: "用户偏好选项式引导", text: "用户偏好结构化选项,而非开放式提问", type: "user", today: "2026-06-18" }));
    const out = await memoryReadTool.handler({ query: "选项式" }, ctx());
    expect(out).toContain("结构化选项");
  });

  it("关键词【在正文不在名字】也能搜到(吸收 search 的能力)", async () => {
    const dir = path.join(home, ".dao", "knowledge");
    // 名字 slug 不含 "立体声",但正文含 → 只按名字匹配会漏,按名+正文能搜到。
    await writeMemory(dir, newMemory({ name: "avaudioengine-format-nil", text: "AVAudioEngine 用 format:nil 会自动协商为立体声,单声道 buffer 会 crash", type: "procedural", today: "2026-06-18" }));
    const out = await memoryReadTool.handler({ query: "立体声 crash" }, ctx());
    expect(out).toContain("AVAudioEngine");
  });

  it("跨三层加载(用户级 + 知识库在沙箱外,仍可读)", async () => {
    await writeMemory(path.join(home, ".dao", "knowledge"), newMemory({ name: "k1", text: "知识库里的跨项目技术事实", type: "procedural", today: "2026-06-18" }));
    const out = await memoryReadTool.handler({ query: "跨项目技术" }, ctx());
    expect(out).toContain("知识库里的跨项目");
  });

  it("找不到 → 明确告知,不编造", async () => {
    const out = await memoryReadTool.handler({ query: "完全无关的量子物理" }, ctx());
    expect(out).toMatch(/未找到|暂无记忆/);
  });
});
