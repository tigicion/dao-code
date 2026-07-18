import { describe, it, expect } from "vitest";
import { BUNDLED_AGENTS, GENERAL_PURPOSE_AGENT, EXPLORE_AGENT, PLAN_AGENT, VERIFY_AGENT } from "./bundled_agents.js";

describe("BUNDLED_AGENTS", () => {
  it("包含 4 个内置 agent", () => {
    expect(BUNDLED_AGENTS.length).toBe(4);
  });

  it("每个 agent 有 agentType 和 whenToUse", () => {
    for (const a of BUNDLED_AGENTS) {
      expect(a.agentType).toBeTruthy();
      expect(a.whenToUse).toBeTruthy();
      expect(a.source).toBe("built-in");
    }
  });
});

describe("EXPLORE_AGENT", () => {
  it("disallowedTools 含 agent/edit/write", () => {
    expect(EXPLORE_AGENT.disallowedTools).toContain("agent");
    expect(EXPLORE_AGENT.disallowedTools).toContain("edit_file");
    expect(EXPLORE_AGENT.disallowedTools).toContain("write_file");
  });
  it("omitClaudeMd = true", () => {
    expect(EXPLORE_AGENT.omitClaudeMd).toBe(true);
  });
  it("model = flash", () => {
    expect(EXPLORE_AGENT.model).toContain("flash");
  });
});

describe("PLAN_AGENT", () => {
  it("disallowedTools 含 agent/edit/write/exec_shell", () => {
    expect(PLAN_AGENT.disallowedTools).toContain("agent");
    expect(PLAN_AGENT.disallowedTools).toContain("exec_shell");
  });
  it("omitClaudeMd = true", () => {
    expect(PLAN_AGENT.omitClaudeMd).toBe(true);
  });
});

describe("VERIFY_AGENT", () => {
  it("background = true", () => {
    expect(VERIFY_AGENT.background).toBe(true);
  });
  it("disallowedTools 含 agent/edit/write", () => {
    expect(VERIFY_AGENT.disallowedTools).toContain("agent");
  });
  it("permissionMode = acceptEdits(对标 CC:子代理编辑不弹审批)", () => {
    expect(VERIFY_AGENT.permissionMode).toBe("acceptEdits");
  });
});

describe("GENERAL_PURPOSE_AGENT", () => {
  it("memory = project", () => {
    expect(GENERAL_PURPOSE_AGENT.memory).toBe("project");
  });
  it("tools = undefined(全部)", () => {
    expect(GENERAL_PURPOSE_AGENT.tools).toBeUndefined();
  });
  it("permissionMode = acceptEdits(对标 CC:子代理编辑不弹审批)", () => {
    expect(GENERAL_PURPOSE_AGENT.permissionMode).toBe("acceptEdits");
  });
});
