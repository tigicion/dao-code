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
