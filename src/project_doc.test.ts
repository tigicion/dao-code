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

  it("DAO.local.md → 叠加在 DAO.md 之上(更高优先级,排在后)", async () => {
    await fs.mkdir(path.join(ws, ".git"), { recursive: true });
    await fs.writeFile(path.join(ws, "DAO.md"), "提交规范");
    await fs.writeFile(path.join(ws, "DAO.local.md"), "我的私有偏好");
    const out = loadProjectInstructions(ws);
    expect(out).toContain("提交规范");
    expect(out).toContain("我的私有偏好");
    expect(out.indexOf("提交规范")).toBeLessThan(out.indexOf("我的私有偏好")); // local 在后=更高优先
  });

  it("从子目录向上溯到 git 根:外层通用 + 内层特定都收,内层排在后(更具体)", async () => {
    await fs.mkdir(path.join(ws, ".git"), { recursive: true });
    await fs.writeFile(path.join(ws, "DAO.md"), "仓库根约定");
    const sub = path.join(ws, "packages", "app");
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(sub, "DAO.md"), "子包特定约定");
    const out = loadProjectInstructions(sub); // 在子包里启动
    expect(out).toContain("仓库根约定");
    expect(out).toContain("子包特定约定");
    expect(out.indexOf("仓库根约定")).toBeLessThan(out.indexOf("子包特定约定")); // 根在前、子包在后
  });

  it("无 .git → 不向上溯,只读当前目录(不扫无关父目录)", async () => {
    // ws 下无 .git;父目录里放个 DAO.md 不应被读到。
    const sub = path.join(ws, "nested");
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(ws, "DAO.md"), "父目录约定");
    await fs.writeFile(path.join(sub, "DAO.md"), "当前目录约定");
    const out = loadProjectInstructions(sub);
    expect(out).toContain("当前目录约定");
    expect(out).not.toContain("父目录约定");
  });
});
