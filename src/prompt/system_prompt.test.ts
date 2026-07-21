import { describe, it, expect } from "vitest";
import { buildSystemPrompt, LONG_TASK_DIRECTIVE, LONG_TASK_DIRECTIVE_EN } from "./system_prompt.js";

describe("buildSystemPrompt (zh)", () => {
  const prompt = buildSystemPrompt({
    modelId: "deepseek-v4-pro",
    toolSummaries: "- Read:读文件\n- Write:写文件",
    projectInstructions: "### DAO.md @ .\n这是项目指令内容",
  });

  it("contains the identity line", () => {
    expect(prompt).toContain("交互式智能助手");
  });

  it("injects the tool summaries", () => {
    expect(prompt).toContain("- Read:读文件");
    expect(prompt).toContain("- Write:写文件");
  });


  it("reflectMemoryEnabled/reflectChallengerEnabled 默认都关闭 → 整段审视/反思提醒都不出现", () => {
    expect(prompt).not.toContain("[审视者]");
    expect(prompt).not.toContain("[纠偏者]");
    expect(prompt).not.toContain("[反思]");
    expect(prompt).not.toContain("审视与反思提醒"); // 两个开关都关时,整段标题+正文都被去掉
  });

  it("reflectMemoryEnabled:true(单开)→ 只提 [反思],不提审视者/纠偏者", () => {
    const p = buildSystemPrompt({
      modelId: "deepseek-v4-pro",
      toolSummaries: "- Read:读文件",
      reflectMemoryEnabled: true,
    });
    expect(p).toContain("[反思]");
    expect(p).not.toContain("[审视者]");
    expect(p).not.toContain("[纠偏者]");
    expect(p).toMatch(/不得默默忽略|看到即停|停下来显式处理/);
  });

  it("reflectChallengerEnabled:true(单开)→ 只提审视者/纠偏者,不提 [反思]", () => {
    const p = buildSystemPrompt({
      modelId: "deepseek-v4-pro",
      toolSummaries: "- Read:读文件",
      reflectChallengerEnabled: true,
    });
    expect(p).toContain("[审视者]");
    expect(p).toContain("[纠偏者]");
    expect(p).not.toContain("[反思]");
  });

  it("两个都开 → 三个 tag 都出现", () => {
    const p = buildSystemPrompt({
      modelId: "deepseek-v4-pro",
      toolSummaries: "- Read:读文件",
      reflectMemoryEnabled: true,
      reflectChallengerEnabled: true,
    });
    expect(p).toContain("[审视者]");
    expect(p).toContain("[反思]");
    expect(p).toContain("[纠偏者]");
  });

  it("项目指令注入到独立段落", () => {
    expect(prompt).toContain("# 项目指令");
    expect(prompt).toContain("这是项目指令内容");
  });

  it("权威层级第4条不含括号引用", () => {
    expect(prompt).not.toContain("见下方");
    expect(prompt).not.toContain("{project_instruction_files}");
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

  it("injects env snapshot when provided", () => {
    const p = buildSystemPrompt({
      modelId: "m",
      toolSummaries: "- a:b",
      envSnapshot: "- 可用语言/工具: node v20.0.0\n- Git 分支: master (干净)",
    });
    expect(p).toContain("可用语言/工具: node v20.0.0");
    expect(p).toContain("Git 分支: master (干净)");
  });

  it("renders no stray placeholder text when env snapshot is omitted", () => {
    const p = buildSystemPrompt({ modelId: "m", toolSummaries: "- a:b" });
    expect(p).not.toContain("{env_snapshot}");
  });

  it("interactive 省略/true → 不出现无人值守的会话特定指引", () => {
    const p1 = buildSystemPrompt({ modelId: "m", toolSummaries: "- a:b" });
    const p2 = buildSystemPrompt({ modelId: "m", toolSummaries: "- a:b", interactive: true });
    expect(p1).not.toContain("AskUserQuestion 不会有人来回答");
    expect(p2).not.toContain("AskUserQuestion 不会有人来回答");
  });

  it("interactive: false → 注入会话特定指引,告知 AskUserQuestion 没人回答、按合理默认推进", () => {
    const p = buildSystemPrompt({ modelId: "m", toolSummaries: "- a:b", interactive: false });
    expect(p).toContain("会话特定指引");
    expect(p).toContain("AskUserQuestion 不会有人来回答");
    expect(p).toContain("合理默认");
  });

  it("行动纪律区分'设计决定'与'行为预测':说'让我测试一下'却用文字模拟结果算破戒", () => {
    expect(prompt).toContain("描述一次运行不等于真的运行过");
    expect(prompt).toContain("让我测试/验证/检查一下");
  });

  it("行动纪律的'重复2-3次'算术/位置推导规则,zh 模板与 en 模板保持同步(此前 317b130 只改了 en)", () => {
    expect(prompt).toContain("已经重做了2-3次");
  });
});

describe("buildSystemPrompt (en)", () => {
  const prompt = buildSystemPrompt({
    modelId: "deepseek-v4-pro",
    toolSummaries: "- Read:Reads a text file\n- Write:Writes a file",
    lang: "en",
  });

  it("contains the identity line", () => {
    expect(prompt).toContain("interactive intelligent assistant");
  });

  it("injects the tool summaries", () => {
    expect(prompt).toContain("- Read:Reads a text file");
    expect(prompt).toContain("- Write:Writes a file");
  });

  it("uses English section headers", () => {
    expect(prompt).toContain("# Who You Are");
    expect(prompt).toContain("# Authority Hierarchy");
    expect(prompt).toContain("# Honesty");
    expect(prompt).toContain("# Project Instructions");
    expect(prompt).toContain("# Tools");
    expect(prompt).toContain("# Memory");
  });


  it("两个开关默认都关闭 → 整段 advisory/reflection reminders 都不出现", () => {
    expect(prompt).not.toContain("[审视者]");
    expect(prompt).not.toContain("[纠偏者]");
    expect(prompt).not.toContain("[反思]");
    expect(prompt).not.toContain("Advisory & Reflection Reminders");
  });

  it("reflectMemoryEnabled:true(单开)→ 提示词里补上 [反思],不提审视者/纠偏者", () => {
    const p = buildSystemPrompt({
      modelId: "deepseek-v4-pro",
      toolSummaries: "- Read:Reads a text file",
      lang: "en",
      reflectMemoryEnabled: true,
    });
    expect(p).toContain("[反思]");
    expect(p).not.toContain("[审视者]");
  });

  it("reflectChallengerEnabled:true(单开)→ 提示词里补上审视者/纠偏者,不提 [反思]", () => {
    const p = buildSystemPrompt({
      modelId: "deepseek-v4-pro",
      toolSummaries: "- Read:Reads a text file",
      lang: "en",
      reflectChallengerEnabled: true,
    });
    expect(p).toContain("[审视者]");
    expect(p).toContain("[纠偏者]");
    expect(p).not.toContain("[反思]");
  });

  it("authority hierarchy item 4 has no parenthetical reference", () => {
    expect(prompt).not.toContain("see {project_instruction_files}");
    expect(prompt).not.toContain("{project_instruction_files}");
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

  it("interactive: false → injects session-specific guidance about AskUserQuestion having no one to answer", () => {
    const p = buildSystemPrompt({ modelId: "m", toolSummaries: "- a:b", lang: "en", interactive: false });
    expect(p).toContain("Session-Specific Guidance");
    expect(p).toContain("AskUserQuestion has no one to answer it");
    expect(p).toContain("reasonable default");
  });

  it("interactive 省略/true → no unattended-session guidance", () => {
    const p1 = buildSystemPrompt({ modelId: "m", toolSummaries: "- a:b", lang: "en" });
    const p2 = buildSystemPrompt({ modelId: "m", toolSummaries: "- a:b", lang: "en", interactive: true });
    expect(p1).not.toContain("AskUserQuestion has no one to answer it");
    expect(p2).not.toContain("AskUserQuestion has no one to answer it");
  });

  it("Action Discipline distinguishes design decisions from behavior predictions: saying 'let me test' then narrating the result instead of calling a tool still breaks the rule", () => {
    expect(prompt).toContain("a described run is not a run");
    expect(prompt).toContain("let me test/verify/check this");
  });

  it("Write-first rule: code in reasoning must be written to disk via Write tool before fixing bugs", () => {
    expect(prompt).toContain("Write-first for new files");
    expect(prompt).toContain("infinitely more valuable than a perfect design");
    expect(prompt).toContain("Never delete and rewrite from scratch");
    expect(prompt).toContain('"Write it down" means calling the Write tool');
  });

  it("Hit-a-wall rule: 2 consecutive failures force categorically different approach", () => {
    expect(prompt).toContain("failed 2 consecutive times");
    expect(prompt).toContain("categorically different approach");
    expect(prompt).toContain("retrying a 3rd");
    expect(prompt).toContain("Don't confuse \"viable\"");
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
