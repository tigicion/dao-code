import { describe, it, expect } from "vitest";
import { buildSystemPrompt, LONG_TASK_DIRECTIVE, LONG_TASK_DIRECTIVE_EN } from "./system_prompt.js";

describe("buildSystemPrompt (zh)", () => {
  const prompt = buildSystemPrompt({
    modelId: "deepseek-v4-pro",
    toolSummaries: "- read_file:读文件\n- write_file:写文件",
    projectInstructions: "(无)",
  });

  it("substitutes the model id", () => {
    expect(prompt).toContain("deepseek-v4-pro");
  });

  it("injects the tool summaries", () => {
    expect(prompt).toContain("- read_file:读文件");
    expect(prompt).toContain("- write_file:写文件");
  });

  it("describes the two modes", () => {
    expect(prompt).toContain("plan");
    expect(prompt).toMatch(/只读|提方案/);
  });

  it("含模型/上下文选型政策", () => {
    expect(prompt).toMatch(/deepseek-v4-flash/);
    expect(prompt).toMatch(/pro/);
    expect(prompt).toMatch(/技能.*不得|不得据此|技能能改的是/);
    expect(prompt).toMatch(/模型.*上下文|上下文.*模型/);
  });

  it("含审视/反思提醒段", () => {
    expect(prompt).toContain("审视者·参考");
    expect(prompt).toContain("反思·参考");
    expect(prompt).toMatch(/不得默默忽略|必须当轮|停下来显式处理/);
  });

  it("leaves no unfilled placeholders", () => {
    expect(prompt).not.toMatch(/\{[a-z_]+\}/);
  });

  it("defaults project instructions to (无) when omitted", () => {
    const p2 = buildSystemPrompt({ modelId: "x", toolSummaries: "- a:b" });
    expect(p2).toContain("(无)");
  });

  it("injects memories when provided", () => {
    const p = buildSystemPrompt({
      modelId: "m",
      toolSummaries: "- a:b",
      memories: "- 用户偏好 TypeScript\n- 本项目用 vitest",
    });
    expect(p).toContain("用户偏好 TypeScript");
    expect(p).toContain("本项目用 vitest");
  });

  it("shows (暂无) when no memories", () => {
    const p = buildSystemPrompt({ modelId: "m", toolSummaries: "- a:b" });
    expect(p).toContain("(暂无)");
  });
});

describe("buildSystemPrompt (en)", () => {
  const prompt = buildSystemPrompt({
    modelId: "deepseek-v4-pro",
    toolSummaries: "- read_file:Reads a text file\n- write_file:Writes a file",
    lang: "en",
  });

  it("substitutes the model id", () => {
    expect(prompt).toContain("deepseek-v4-pro");
  });

  it("injects the tool summaries", () => {
    expect(prompt).toContain("- read_file:Reads a text file");
    expect(prompt).toContain("- write_file:Writes a file");
  });

  it("uses English section headers", () => {
    expect(prompt).toContain("# Who You Are");
    expect(prompt).toContain("# Authority Hierarchy");
    expect(prompt).toContain("# Honesty");
    expect(prompt).toContain("# Tools");
    expect(prompt).toContain("# Memory");
  });

  it("describes the two modes", () => {
    expect(prompt).toContain("plan");
    expect(prompt).toMatch(/read.only|propose plans/);
  });

  it("references flash model policy", () => {
    expect(prompt).toMatch(/deepseek-v4-flash/);
    expect(prompt).toMatch(/pro/);
  });

  it("包含 advisory/reflection reminders", () => {
    expect(prompt).toContain("审视者·参考");
    expect(prompt).toContain("反思·参考");
    // The English BODY keeps the original Chinese prefixes
  });

  it("leaves no unfilled placeholders", () => {
    expect(prompt).not.toMatch(/\{[a-z_]+\}/);
  });

  it("defaults project instructions to (none) when omitted", () => {
    const p2 = buildSystemPrompt({ modelId: "x", toolSummaries: "- a:b", lang: "en" });
    expect(p2).toContain("(none)");
    // Should NOT have Chinese placeholder
    expect(p2).not.toContain("(无)");
  });

  it("injects memories when provided", () => {
    const p = buildSystemPrompt({
      modelId: "m",
      toolSummaries: "- a:b",
      memories: "- User prefers TypeScript\n- Uses vitest",
      lang: "en",
    });
    expect(p).toContain("User prefers TypeScript");
    expect(p).toContain("Uses vitest");
  });

  it("shows (none yet) when no memories", () => {
    const p = buildSystemPrompt({ modelId: "m", toolSummaries: "- a:b", lang: "en" });
    expect(p).toContain("(none yet)");
  });

  it("defaults to zh when lang is omitted", () => {
    const p = buildSystemPrompt({ modelId: "m", toolSummaries: "- a:b" });
    expect(p).toContain("# 你是谁");
    expect(p).not.toContain("# Who You Are");
  });
});

describe("LONG_TASK_DIRECTIVE", () => {
  it("zh directive starts with Chinese", () => {
    expect(LONG_TASK_DIRECTIVE).toContain("长任务自主模式");
  });

  it("en directive starts with English", () => {
    expect(LONG_TASK_DIRECTIVE_EN).toContain("Long-task autonomous mode");
  });
});
