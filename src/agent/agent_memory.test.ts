// src/agent/agent_memory.test.ts
import { describe, it, expect } from "vitest";
import {
  getAgentMemoryDir,
  getAgentMemoryEntrypoint,
  loadAgentMemoryPrompt,
  isAgentMemoryPath,
  getMemoryScopeDisplay,
} from "./agent_memory.js";

const TEST_HOME = "/tmp/dao-test-home";

describe("getAgentMemoryDir", () => {
  it("project scope -> <cwd>/.dao/agents/memory/<agentType>/", () => {
    const dir = getAgentMemoryDir("my-agent", "project", TEST_HOME);
    expect(dir).toContain(".dao");
    expect(dir).toContain("agents");
    expect(dir).toContain("memory");
    expect(dir).toContain("my-agent");
    expect(dir.endsWith("/")).toBe(true);
  });

  it("user scope -> <home>/.dao/agents/memory/<agentType>/", () => {
    const dir = getAgentMemoryDir("reviewer", "user", TEST_HOME);
    expect(dir).toContain(TEST_HOME);
    expect(dir).toContain(".dao");
    expect(dir).toContain("reviewer");
  });

  it("local scope -> <cwd>/.dao/agents/memory/<agentType>/local/", () => {
    const dir = getAgentMemoryDir("tester", "local", TEST_HOME);
    expect(dir).toContain("tester");
    expect(dir).toContain("local");
  });

  it("agentType 含冒号 -> 替换为横线(跨平台路径安全)", () => {
    const dir = getAgentMemoryDir("plugin:my-agent", "project", TEST_HOME);
    expect(dir).toContain("plugin-my-agent");
    expect(dir).not.toContain("plugin:my-agent");
  });
});

describe("getAgentMemoryEntrypoint", () => {
  it("返回 memory.md 路径", () => {
    const entry = getAgentMemoryEntrypoint("my-agent", "project", TEST_HOME);
    expect(entry).toContain("memory.md");
    expect(entry).toContain("my-agent");
  });
});

describe("loadAgentMemoryPrompt", () => {
  it("包含记忆说明文本", () => {
    const prompt = loadAgentMemoryPrompt("general-purpose", "project", TEST_HOME);
    expect(prompt).toContain("记忆");
    expect(prompt.length).toBeGreaterThan(50);
  });

  it("user scope 包含跨项目提示", () => {
    const prompt = loadAgentMemoryPrompt("my-agent", "user", TEST_HOME);
    expect(prompt).toContain("跨项目");
  });

  it("project scope 包含项目级提示", () => {
    const prompt = loadAgentMemoryPrompt("my-agent", "project", TEST_HOME);
    expect(prompt).toContain("项目");
  });

  it("local scope 包含本地级提示", () => {
    const prompt = loadAgentMemoryPrompt("my-agent", "local", TEST_HOME);
    expect(prompt).toContain("本地");
  });

  it("包含记忆文件路径", () => {
    const prompt = loadAgentMemoryPrompt("reviewer", "project", TEST_HOME);
    expect(prompt).toContain("memory.md");
  });
});

describe("isAgentMemoryPath", () => {
  it("project scope 路径 -> true", () => {
    const dir = getAgentMemoryDir("my-agent", "project", TEST_HOME);
    const file = dir + "memory.md";
    expect(isAgentMemoryPath(file, TEST_HOME)).toBe(true);
  });

  it("user scope 路径 -> true", () => {
    const dir = getAgentMemoryDir("my-agent", "user", TEST_HOME);
    const file = dir + "memory.md";
    expect(isAgentMemoryPath(file, TEST_HOME)).toBe(true);
  });

  it("local scope 路径 -> true", () => {
    const dir = getAgentMemoryDir("my-agent", "local", TEST_HOME);
    const file = dir + "memory.md";
    expect(isAgentMemoryPath(file, TEST_HOME)).toBe(true);
  });

  it("无关路径 -> false", () => {
    expect(isAgentMemoryPath("/etc/passwd", TEST_HOME)).toBe(false);
    expect(isAgentMemoryPath("/tmp/random/file.txt", TEST_HOME)).toBe(false);
  });
});

describe("getMemoryScopeDisplay", () => {
  it("user -> 含 User 标记", () => {
    const display = getMemoryScopeDisplay("user", TEST_HOME);
    expect(display).toContain("User");
  });

  it("project -> 含 Project 标记", () => {
    const display = getMemoryScopeDisplay("project", TEST_HOME);
    expect(display).toContain("Project");
  });

  it("local -> 含 Local 标记", () => {
    const display = getMemoryScopeDisplay("local", TEST_HOME);
    expect(display).toContain("Local");
  });

  it("undefined -> None", () => {
    const display = getMemoryScopeDisplay(undefined, TEST_HOME);
    expect(display).toContain("None");
  });
});
