import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { memoryWriteTool } from "./memory_write.js";
import type { ToolContext } from "./types.js";

let root: string;
function ctx(): ToolContext {
  return { workspaceRoot: root, today: "2026-06-07", homeDir: root };
}
function memDir() {
  return path.join(root, ".dao", "memory");
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "dao-memwrite-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("memory_write tool", () => {
  it("records a project-scope memory as typed md", async () => {
    const out = await memoryWriteTool.handler({ text: "本项目用 vitest" }, ctx());
    expect(out).toContain("已记住");
    expect(out).toContain("项目级");
    const files = (await fs.readdir(memDir())).filter((f) => f.endsWith(".md"));
    expect(files.length).toBe(1);
    const raw = await fs.readFile(path.join(memDir(), files[0] ?? ""), "utf8");
    expect(raw).toMatch(/type: semantic/);
    expect(raw).toContain("本项目用 vitest");
  });

  it("procedural(跨项目知识)落知识库目录 + 存 sourceHash", async () => {
    await fs.writeFile(path.join(root, "package.json"), '{"packageManager":"pnpm@9"}');
    const out = await memoryWriteTool.handler(
      { text: "项目用 pnpm", type: "procedural", source: "package.json" },
      ctx(),
    );
    expect(out).toMatch(/已记住/);
    expect(out).toContain("知识库");
    const knowledgeDir = path.join(root, ".dao", "knowledge");
    const files = (await fs.readdir(knowledgeDir)).filter((f) => f.endsWith(".md"));
    expect(files.length).toBe(1);
    const raw = await fs.readFile(path.join(knowledgeDir, files[0] ?? ""), "utf8");
    expect(raw).toMatch(/type: procedural/);
    expect(raw).toMatch(/source: package.json/);
    expect(raw).toMatch(/sourceHash: [0-9a-f]{16}/);
  });

  it("同 title → 精确键覆盖更新(不新增)", async () => {
    await memoryWriteTool.handler({ title: "包管理器", text: "项目用 pnpm 安装依赖" }, ctx());
    const out = await memoryWriteTool.handler({ title: "包管理器", text: "项目用 pnpm 安装依赖包" }, ctx());
    expect(out).toContain("已更新");
    const files = (await fs.readdir(memDir())).filter((f) => f.endsWith(".md"));
    expect(files.length).toBe(1);
  });

  it("不同 title(正文相近)→ 新增(语义合并交反思器,store 不模糊)", async () => {
    await memoryWriteTool.handler({ title: "包管理器 A", text: "项目用 pnpm 安装依赖" }, ctx());
    const out = await memoryWriteTool.handler({ title: "包管理器 B", text: "项目用 pnpm 安装依赖包" }, ctx());
    expect(out).toContain("已记住");
    expect((await fs.readdir(memDir())).filter((f) => f.endsWith(".md")).length).toBe(2);
  });

  it("delete: true 真删文件(不留墓碑)", async () => {
    await memoryWriteTool.handler({ title: "临时事实", text: "稍后要删" }, ctx());
    expect((await fs.readdir(memDir())).filter((f) => f.endsWith(".md")).length).toBe(1);
    const out = await memoryWriteTool.handler({ title: "临时事实", delete: true }, ctx());
    expect(out).toContain("已删除记忆");
    expect((await fs.readdir(memDir())).filter((f) => f.endsWith(".md")).length).toBe(0);
  });

  it("delete 无命中给提示", async () => {
    const out = await memoryWriteTool.handler({ title: "不存在的", delete: true }, ctx());
    expect(out).toContain("未找到匹配记忆");
  });

  it("delete 缺 title/text 报错", async () => {
    const out = await memoryWriteTool.handler({ delete: true }, ctx());
    expect(out).toContain("删除失败");
  });

  it("declares plan capability and auto approval", () => {
    expect(memoryWriteTool.capability).toBe("plan");
    expect(memoryWriteTool.approval).toBe("auto");
    expect(memoryWriteTool.name).toBe("memory_write");
  });
});
