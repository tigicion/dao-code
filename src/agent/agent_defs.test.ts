import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAgentDef, loadAgentDefs } from "./agent_defs.js";

describe("parseAgentDef", () => {
  it("解析 frontmatter + 正文(name/description/tools/model/prompt)", () => {
    const def = parseAgentDef(
      "code-reviewer",
      `---\nname: code-reviewer\ndescription: 审查代码\ntools: read_file, grep_files\nmodel: deepseek-v4-pro\n---\n你是代码审查专家。`,
    );
    expect(def).not.toBeNull();
    expect(def!.name).toBe("code-reviewer");
    expect(def!.description).toBe("审查代码");
    expect(def!.tools).toEqual(["read_file", "grep_files"]);
    expect(def!.model).toBe("deepseek-v4-pro");
    expect(def!.prompt).toBe("你是代码审查专家。");
  });

  it("无正文 → null", () => {
    expect(parseAgentDef("x", `---\nname: x\n---\n`)).toBeNull();
  });

  it("缺 frontmatter 也用文件名当名字", () => {
    const def = parseAgentDef("helper", "就是个助手");
    expect(def?.name).toBe("helper");
    expect(def?.prompt).toBe("就是个助手");
  });
});

describe("parseAgentDef tools 解析", () => {
  const md = (tools: string) => `---\nname: t\ndescription: d\ntools: ${tools}\n---\n正文`;
  it("纯列举 → include 列表(兼容旧行为)", () => {
    const d = parseAgentDef("t", md("read_file, grep_files"))!;
    expect(d.tools).toEqual(["read_file", "grep_files"]);
    expect(d.toolsExclude).toBeUndefined();
  });
  it("'*, !x, !y' → 全集 + 排除", () => {
    const d = parseAgentDef("t", md("*, !edit_file, !write_file"))!;
    expect(d.tools).toBeUndefined();
    expect(d.toolsExclude).toEqual(["edit_file", "write_file"]);
  });
  it("只有排除项(无 *)也按全集减排除处理", () => {
    const d = parseAgentDef("t", md("!exec_shell"))!;
    expect(d.tools).toBeUndefined();
    expect(d.toolsExclude).toEqual(["exec_shell"]);
  });
  it("无 tools 字段 → 都为 undefined(继承全部)", () => {
    const d = parseAgentDef("t", `---\nname: t\ndescription: d\n---\n正文`)!;
    expect(d.tools).toBeUndefined();
    expect(d.toolsExclude).toBeUndefined();
  });
});

describe("loadAgentDefs", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(path.join(os.tmpdir(), "dao-agents-"));
  });
  it("加载目录下 .md;项目覆盖同名用户定义", async () => {
    const proj = path.join(base, "proj");
    const user = path.join(base, "user");
    mkdirSync(proj, { recursive: true });
    mkdirSync(user, { recursive: true });
    writeFileSync(path.join(user, "a.md"), `---\nname: a\n---\n用户版 a`);
    writeFileSync(path.join(user, "b.md"), `---\nname: b\n---\n用户版 b`);
    writeFileSync(path.join(proj, "a.md"), `---\nname: a\n---\n项目版 a`);
    const defs = await loadAgentDefs(proj, user);
    const a = defs.find((d) => d.name === "a");
    expect(a?.prompt).toBe("项目版 a"); // 项目覆盖
    expect(defs.map((d) => d.name).sort()).toEqual(["a", "b"]);
  });
});
