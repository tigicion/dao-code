import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadProjectInstructions } from "./project_doc.js";

let ws: string;
beforeEach(async () => { ws = await fs.mkdtemp(path.join(os.tmpdir(), "dao-pdoc-")); });
afterEach(async () => { await fs.rm(ws, { recursive: true, force: true }); });

describe("loadProjectInstructions", () => {
  it("无文件 → 空串", async () => {
    expect(loadProjectInstructions(ws)).toBe("");
  });
  it("有 DAO.md → 只读 DAO.md,忽略 AGENTS.md/CLAUDE.md", async () => {
    await fs.writeFile(path.join(ws, "DAO.md"), "dao 约定");
    await fs.writeFile(path.join(ws, "AGENTS.md"), "agents 约定");
    await fs.writeFile(path.join(ws, "CLAUDE.md"), "claude 约定");
    const out = loadProjectInstructions(ws);
    expect(out).toContain("dao 约定");
    expect(out).not.toContain("agents 约定");
    expect(out).not.toContain("claude 约定");
  });
  it("无 DAO.md → 回退,AGENTS.md 优先于 CLAUDE.md", async () => {
    await fs.writeFile(path.join(ws, "AGENTS.md"), "agents 约定");
    await fs.writeFile(path.join(ws, "CLAUDE.md"), "claude 约定");
    const out = loadProjectInstructions(ws);
    expect(out).toContain("agents 约定");
    expect(out).not.toContain("claude 约定");
  });
  it("只有 CLAUDE.md → 读它(开箱兼容)", async () => {
    await fs.writeFile(path.join(ws, "CLAUDE.md"), "claude 约定");
    expect(loadProjectInstructions(ws)).toContain("claude 约定");
  });
});
