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
  it("读 DAO.md / AGENTS.md / CLAUDE.md(都存在则都读,带来源标签)", async () => {
    await fs.writeFile(path.join(ws, "DAO.md"), "dao 约定");
    await fs.writeFile(path.join(ws, "AGENTS.md"), "agents 约定");
    const out = loadProjectInstructions(ws);
    expect(out).toContain("DAO.md");
    expect(out).toContain("dao 约定");
    expect(out).toContain("AGENTS.md");
    expect(out).toContain("agents 约定");
  });
  it("内容相同(如 symlink/复制)→ 去重只取一次", async () => {
    await fs.writeFile(path.join(ws, "AGENTS.md"), "同样的内容");
    await fs.writeFile(path.join(ws, "CLAUDE.md"), "同样的内容");
    const out = loadProjectInstructions(ws);
    expect(out.match(/同样的内容/g)?.length).toBe(1);
  });
});
