import { describe, it, expect } from "vitest";
import { isForeignSkill } from "./adapt.js";

const DAO = new Set(["read_file", "write_file", "edit_file", "exec_shell", "grep_files", "ask_user"]);

describe("isForeignSkill — 无字典结构性检测", () => {
  it("CC 的 CamelCase 工具(反引号/工具语境)→ 外来", () => {
    expect(isForeignSkill("use the `Read` tool then `Bash`", DAO)).toBe(true);
    expect(isForeignSkill("call WebFetch tool to grab it", DAO)).toBe(true);
  });
  it("Codex/Gemini 的非 dao snake 名 → 外来", () => {
    expect(isForeignSkill("emit an `apply_patch` block", DAO)).toBe(true);
    expect(isForeignSkill("use run_shell_command tool to build", DAO)).toBe(true);
  });
  it("superpowers: / 命名空间跨引用 → 外来", () => {
    expect(isForeignSkill("then use superpowers:test-driven-development", DAO)).toBe(true);
  });
  it("纯 dao 技能(snake_case dao 工具、无跨引用)→ 不算外来", () => {
    expect(isForeignSkill("先 `read_file` 再 `edit_file`,跑 `exec_shell` 验证", DAO)).toBe(false);
    expect(isForeignSkill("用 read_file 工具读配置,再 grep_files 工具搜符号", DAO)).toBe(false);
  });
  it("散文里的裸词不误报(没有反引号/工具语境)", () => {
    expect(isForeignSkill("Read the docs and edit your notes carefully", DAO)).toBe(false);
  });
  it("URL/时间不误判成跨引用", () => {
    expect(isForeignSkill("see https://example.com at 12:30 for details", DAO)).toBe(false);
  });
});
