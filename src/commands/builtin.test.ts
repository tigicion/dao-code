import { describe, it, expect } from "vitest";
import { runBuiltinCommand, BUILTIN_COMMANDS } from "./builtin.js";

describe("runBuiltinCommand", () => {
  it("simplify → 质量清理 prompt", () => {
    expect(runBuiltinCommand("simplify", "")?.prompt).toContain("质量清理");
  });
  it("remember 无参 → 用法;有参 → 含事实 + memory_write", () => {
    expect(runBuiltinCommand("remember", "")?.output).toContain("用法");
    const r = runBuiltinCommand("remember", "用户偏好简洁");
    expect(r?.prompt).toContain("memory_write");
    expect(r?.prompt).toContain("用户偏好简洁");
  });
  it("debug-session → 读 .dao/sessions,带问题描述", () => {
    const r = runBuiltinCommand("debug-session", "卡死了");
    expect(r?.prompt).toContain(".dao/sessions");
    expect(r?.prompt).toContain("卡死了");
  });
  it("skillify → 写 .dao/skills + dao 工具名", () => {
    expect(runBuiltinCommand("skillify", "")?.prompt).toContain(".dao/skills");
  });
  it("batch → 含并行 agent + worktree 隔离指引", () => {
    const r = runBuiltinCommand("batch", "把模块拆成微服务");
    expect(r?.prompt).toContain("isolate:true");
    expect(r?.prompt).toContain("把模块拆成微服务");
    expect(runBuiltinCommand("batch", "")?.output).toContain("用法");
  });
  it("security-review → 含安全审查指引;PR 号走 gh", () => {
    expect(runBuiltinCommand("security-review", "")?.prompt).toContain("安全审查");
    expect(runBuiltinCommand("security-review", "42")?.prompt).toContain("gh pr diff 42");
  });
  it("未知命令 → null", () => {
    expect(runBuiltinCommand("nope", "")).toBeNull();
  });
  it("四个命令都有 description", () => {
    for (const k of ["simplify", "remember", "debug-session", "skillify", "batch"]) {
      expect(BUILTIN_COMMANDS[k]?.description).toBeTruthy();
    }
  });
});
