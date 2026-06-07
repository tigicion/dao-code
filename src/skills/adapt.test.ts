import { describe, it, expect } from "vitest";
import { adaptSkillBody, adaptNote } from "./adapt.js";

describe("adaptSkillBody — 探测外来工具名", () => {
  it("`反引号` 或 'X tool' 语境的歧义词才算", () => {
    const a = adaptSkillBody("use the Read tool, then `Bash` to run it");
    expect(a.glossary).toContain("Read → read_file");
    expect(a.glossary).toContain("Bash → exec_shell");
  });
  it("无歧义 CamelCase 名任意出现都算", () => {
    expect(adaptSkillBody("call AskUserQuestion for choices").glossary).toContain("AskUserQuestion → ask_user");
    expect(adaptSkillBody("WebFetch the page").glossary).toContain("WebFetch → fetch_url");
  });
  it("散文里的裸词不误报", () => {
    expect(adaptSkillBody("Read the docs and edit your notes carefully").glossary).toEqual([]);
  });
  it("superpowers: 跨引用被标记", () => {
    expect(adaptSkillBody("then use superpowers:test-driven-development").namespaced).toBe(true);
  });
});

describe("adaptNote — 条件性提示", () => {
  it("无命中 → 空串(不污染)", () => {
    expect(adaptNote({ glossary: [], namespaced: false })).toBe("");
  });
  it("有命中 → 含对照与跨引用说明", () => {
    const note = adaptNote({ glossary: ["Read → read_file"], namespaced: true });
    expect(note).toContain("read_file");
    expect(note).toContain("superpowers:");
  });
});
