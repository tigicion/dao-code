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
  it("捕获 when_to_use(触发条件)与目录 slug 作别名", async () => {
    const proj = path.join(base, "p");
    mkdirSync(path.join(proj, "brainstorming"), { recursive: true });
    writeFileSync(
      path.join(proj, "brainstorming", "SKILL.md"),
      `---\nname: Brainstorming Ideas Into Designs\ndescription: Socratic refinement\nwhen_to_use: before writing code for any feature\n---\n正文`,
    );
    const skills = await loadSkills(proj);
    const s = skills[0]!;
    expect(s.name).toBe("Brainstorming Ideas Into Designs");
    expect(s.whenToUse).toBe("before writing code for any feature");
    expect(s.slug).toBe("brainstorming"); // 目录名作为可调用别名
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
  it("按 slug / 大小写不敏感匹配(模型用直觉名也能加载)", async () => {
    const skills = [{ name: "Brainstorming Ideas Into Designs", slug: "brainstorming", description: "", body: "头脑风暴正文", dir: base }];
    const bySlug = await skillTool.handler({ name: "brainstorming" }, { workspaceRoot: base, skills });
    expect(bySlug).toContain("头脑风暴正文");
    const byCase = await skillTool.handler({ name: "brainstorming ideas into designs" }, { workspaceRoot: base, skills });
    expect(byCase).toContain("头脑风暴正文");
  });
});
