import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "./system_prompt.js";

describe("buildSystemPrompt", () => {
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
