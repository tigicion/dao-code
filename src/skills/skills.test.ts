import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSkills, findUserInvocableSkill, skillCatalogLines } from "./skills.js";
import { skillTool } from "../tools/skill.js";

describe("skillCatalogLines", () => {
  it("格式化 name+描述,带 何时用,slug 异于 name 时给调用名", () => {
    const out = skillCatalogLines([
      { name: "Debugging", description: "系统化调试", whenToUse: "出错时", slug: "systematic-debugging" } as never,
    ]);
    expect(out).toContain("Debugging");
    expect(out).toContain("系统化调试");
    expect(out).toContain("何时用:出错时");
    expect(out).toContain("调用名 systematic-debugging");
  });
  it("modelInvokable:false 的不列;插件用 plugin:slug 调用名", () => {
    const out = skillCatalogLines([
      { name: "手动", description: "x", modelInvokable: false } as never,
      { name: "Foo", description: "y", slug: "foo", namespace: "sp" } as never,
    ]);
    expect(out).not.toContain("手动");
    expect(out).toContain("调用名 sp:foo");
  });
  it("描述+何时用截断到 220 字", () => {
    const out = skillCatalogLines([{ name: "N", description: "d".repeat(500) } as never]);
    expect(out.length).toBeLessThan(240);
  });
});

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
  it("findUserInvocableSkill:按 slug/name/namespace 匹配,排除 user-invocable:false", () => {
    const skills = [
      { name: "TDD", description: "d", slug: "tdd", body: "b1", dir: "" },
      { name: "Auto Only", description: "d", slug: "autoonly", body: "b2", dir: "", userInvocable: false },
      { name: "Plug", description: "d", slug: "plug", namespace: "sp", body: "b3", dir: "" },
    ];
    expect(findUserInvocableSkill(skills, "tdd")?.name).toBe("TDD"); // slug
    expect(findUserInvocableSkill(skills, "TDD")?.name).toBe("TDD"); // name(大小写不敏感)
    expect(findUserInvocableSkill(skills, "sp:plug")?.name).toBe("Plug"); // namespace:slug
    expect(findUserInvocableSkill(skills, "autoonly")).toBeUndefined(); // user-invocable:false 不可手动调
    expect(findUserInvocableSkill(skills, "nope")).toBeUndefined();
  });

  it("解析 disable-model-invocation / user-invocable(默认都开,省略=undefined)", async () => {
    const proj = path.join(base, "p");
    mkdirSync(path.join(proj, "manual"), { recursive: true });
    writeFileSync(path.join(proj, "manual", "SKILL.md"), `---\nname: manual\ndescription: d\ndisable-model-invocation: true\n---\n正文`);
    mkdirSync(path.join(proj, "autoonly"), { recursive: true });
    writeFileSync(path.join(proj, "autoonly", "SKILL.md"), `---\nname: autoonly\ndescription: d\nuser-invocable: false\n---\n正文`);
    mkdirSync(path.join(proj, "plain"), { recursive: true });
    writeFileSync(path.join(proj, "plain", "SKILL.md"), `---\nname: plain\ndescription: d\n---\n正文`);
    const skills = await loadSkills(proj);
    const manual = skills.find((s) => s.name === "manual")!;
    const autoonly = skills.find((s) => s.name === "autoonly")!;
    const plain = skills.find((s) => s.name === "plain")!;
    expect(manual.modelInvokable).toBe(false); // 不让模型自动触发
    expect(autoonly.userInvocable).toBe(false); // 不暴露给用户 /调用
    expect(plain.modelInvokable).toBeUndefined(); // 第三方一般不写 → undefined(按默认开处理)
    expect(plain.userInvocable).toBeUndefined();
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
  it("解析 paths(条件技能)——支持逗号/空格/[]/引号", async () => {
    const proj = path.join(base, "p");
    mkdirSync(path.join(proj, "swift"), { recursive: true });
    writeFileSync(path.join(proj, "swift", "SKILL.md"), `---\nname: swift\ndescription: x\npaths: ["**/*.swift", "**/*.m"]\n---\n正文`);
    mkdirSync(path.join(proj, "plain"), { recursive: true });
    writeFileSync(path.join(proj, "plain", "SKILL.md"), `---\nname: plain\ndescription: x\n---\n正文`);
    const skills = await loadSkills(proj);
    expect(skills.find((s) => s.name === "swift")?.paths).toEqual(["**/*.swift", "**/*.m"]);
    expect(skills.find((s) => s.name === "plain")?.paths).toBeUndefined(); // 无 paths = 一直在场
  });
  it("realpath 去重:同一文件经符号链接被加载两次只留一份", async () => {
    const real = path.join(base, "real");
    mkdirSync(path.join(real, "tdd"), { recursive: true });
    writeFileSync(path.join(real, "tdd", "SKILL.md"), `---\nname: tdd\ndescription: x\n---\n正文`);
    const linkRoot = path.join(base, "linkroot");
    mkdirSync(linkRoot, { recursive: true });
    symlinkSync(path.join(real, "tdd"), path.join(linkRoot, "tdd-alias"), "dir"); // 同文件、不同名/路径
    const skills = await loadSkills(real, linkRoot);
    expect(skills.filter((s) => s.body.includes("正文")).length).toBe(1); // 物理文件去重
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
  it("命名空间调用 plugin:slug 命中插件技能", async () => {
    const skills = [
      { name: "Test-Driven Development", slug: "test-driven-development", namespace: "superpowers", description: "", body: "TDD 正文", dir: base },
      { name: "tdd", slug: "tdd", description: "", body: "本地 TDD", dir: base }, // 撞名:裸 slug 取本地
    ];
    const byNs = await skillTool.handler({ name: "superpowers:test-driven-development" }, { workspaceRoot: base, skills });
    expect(byNs).toContain("TDD 正文"); // 命名空间精确命中插件版
    const bare = await skillTool.handler({ name: "tdd" }, { workspaceRoot: base, skills });
    expect(bare).toContain("本地 TDD"); // 裸 slug 取本地版
  });
});
