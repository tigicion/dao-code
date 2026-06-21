import { describe, it, expect } from "vitest";
import { CHALLENGER_PROMPT } from "./reflect_prompts.js";

describe("CHALLENGER_PROMPT", () => {
  it("含'用户重复申诉/质疑前提'自查", () => {
    expect(CHALLENGER_PROMPT).toContain("重复");
    expect(CHALLENGER_PROMPT).toContain("前提");
  });
  it("含'新任务则说在轨、不硬找茬'的免误报出口", () => {
    expect(CHALLENGER_PROMPT).toContain("在轨");
  });
});
