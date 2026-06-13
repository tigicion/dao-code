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
  it("Gemini CLI 的 snake 多词名任意出现都算", () => {
    expect(adaptSkillBody("use run_shell_command to build").glossary).toContain("run_shell_command → exec_shell");
    expect(adaptSkillBody("call search_file_content").glossary).toContain("search_file_content → grep_files");
  });
  it("Codex apply_patch / Cursor run_terminal_cmd 被探测", () => {
    expect(adaptSkillBody("emit an apply_patch block").glossary).toContain("apply_patch → edit_file");
    expect(adaptSkillBody("run_terminal_cmd to install").glossary).toContain("run_terminal_cmd → exec_shell");
  });
  it("歧义小写名(shell/glob/replace)仅在反引号/工具语境算", () => {
    expect(adaptSkillBody("the `replace` tool edits in place").glossary).toContain("replace → edit_file");
    expect(adaptSkillBody("please replace the placeholder text").glossary).toEqual([]);
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
