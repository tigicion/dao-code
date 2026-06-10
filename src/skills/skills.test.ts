import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSkills } from "./skills.js";
import { skillTool } from "../tools/skill.js";

let base: string;
beforeEach(() => {
  base = mkdtempSync(path.join(os.tmpdir(), "dao-skills-"));
});

describe("loadSkills", () => {
  it("加载 <name>/SKILL.md 与扁平 <name>.md", async () => {
    const proj = path.join(base, "p");
    mkdirSync(path.join(proj, "pdf"), { recursive: true });
    writeFileSync(path.join(proj, "pdf", "SKILL.md"), `---\nname: pdf\ndescription: 处理 PDF\n---\nPDF 步骤……`);
    writeFileSync(path.join(proj, "commit.md"), `---\ndescription: 规范提交\n---\n提交步骤……`);
    const skills = await loadSkills(proj, path.join(base, "nouser"));
    expect(skills.map((s) => s.name).sort()).toEqual(["commit", "pdf"]);
    expect(skills.find((s) => s.name === "pdf")?.body).toContain("PDF 步骤");
  });
});

describe("skill 工具", () => {
  it("加载已知 skill 正文", async () => {
    const out = await skillTool.handler(
      { name: "pdf" },
      { workspaceRoot: base, skills: [{ name: "pdf", description: "处理 PDF", body: "PDF 步骤详解", dir: base }] },
    );
    expect(out).toContain("Skill: pdf");
    expect(out).toContain("PDF 步骤详解");
  });
  it("未知 skill → 列出可用", async () => {
    const out = await skillTool.handler(
      { name: "nope" },
      { workspaceRoot: base, skills: [{ name: "pdf", description: "", body: "x", dir: base }] },
    );
    expect(out).toContain("未找到 skill");
    expect(out).toContain("pdf");
  });
});
