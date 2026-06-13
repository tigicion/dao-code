import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { skillInstallTool } from "./skill_install.js";

let src: string, ws: string;
beforeEach(async () => {
  src = await fs.mkdtemp(path.join(os.tmpdir(), "dao-si-src-"));
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "dao-si-ws-"));
});
afterEach(async () => { await fs.rm(src, { recursive: true, force: true }); await fs.rm(ws, { recursive: true, force: true }); });

describe("skill_install 工具", () => {
  it("声明 exec + 需审批", () => {
    expect(skillInstallTool.capability).toBe("exec");
    expect(skillInstallTool.approval).toBe("required");
  });
  it("从本地路径装到 project 层,报告外来工具名", async () => {
    await fs.mkdir(path.join(src, "skills", "demo"), { recursive: true });
    await fs.writeFile(path.join(src, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: x\n---\n用 `Read` 工具");
    const out = await skillInstallTool.handler({ source: src, scope: "project" }, { workspaceRoot: ws });
    expect(out).toContain("安装 1 个技能");
    expect(await fs.readFile(path.join(ws, ".dao", "skills", "demo", "SKILL.md"), "utf8")).toContain("name: demo");
  });
});
