import { describe, it, expect } from "vitest";
import { parseAgentDef, type AgentDef } from "./agent_defs.js";

describe("parseAgentDef", () => {
  it("解析最小 frontmatter(只有 name + body)", () => {
    const raw = `---
name: my-agent
description: 测试 agent
---
你是一个测试 agent。`;
    const def = parseAgentDef("my-agent", raw);
    expect(def).not.toBeNull();
    expect(def!.agentType).toBe("my-agent");
    expect(def!.whenToUse).toBe("测试 agent");
    expect(def!.source).toBe("userSettings");
    expect(def!.getSystemPrompt()).toBe("你是一个测试 agent。");
  });

  it("解析完整 frontmatter(所有字段)", () => {
    const raw = `---
name: reviewer
description: 代码审查
tools: "read_file, grep_files"
disallowedTools: "write_file"
model: deepseek-v4-flash
permissionMode: plan
maxTurns: 50
skills: "code-review"
memory: project
background: true
isolation: worktree
color: red
omitClaudeMd: true
initialPrompt: "/review"
---
审查代码`;
    const def = parseAgentDef("reviewer", raw) as AgentDef;
    expect(def!.agentType).toBe("reviewer");
    expect(def!.tools).toEqual(["read_file", "grep_files"]);
    expect(def!.disallowedTools).toEqual(["write_file"]);
    expect(def!.model).toBe("deepseek-v4-flash");
    expect(def!.permissionMode).toBe("plan");
    expect(def!.maxTurns).toBe(50);
    expect(def!.skills).toEqual(["code-review"]);
    expect(def!.memory).toBe("project");
    expect(def!.background).toBe(true);
    expect(def!.isolation).toBe("worktree");
    expect(def!.color).toBe("red");
    expect(def!.omitClaudeMd).toBe(true);
    expect(def!.initialPrompt).toBe("/review");
  });

  it("省略 tools = undefined(全部工具)", () => {
    const raw = `---
name: full
description: 全工具
---
go`;
    const def = parseAgentDef("full", raw);
    expect(def!.tools).toBeUndefined();
  });

  it("tools 含 * = undefined(全部工具)", () => {
    const raw = `---
name: star
description: 星号
tools: "*"
---
go`;
    const def = parseAgentDef("star", raw);
    expect(def!.tools).toBeUndefined();
  });

  it("缺少 name 返回 null", () => {
    const raw = `---
description: 无名
---
body`;
    expect(parseAgentDef("file", raw)).toBeNull();
  });

  it("缺少 body 返回 null", () => {
    const raw = `---
name: empty
description: 空 body
---`;
    expect(parseAgentDef("empty", raw)).toBeNull();
  });

  it("hooks 解析", () => {
    const raw = `---
name: hooked
description: 有 hooks
hooks:
  SubagentStart:
    - command: "echo start"
  SubagentStop:
    - command: "echo stop"
---
body`;
    const def = parseAgentDef("hooked", raw);
    expect(def!.hooks).toBeDefined();
    expect(def!.hooks!.SubagentStart).toEqual([{ command: "echo start" }]);
    expect(def!.hooks!.SubagentStop).toEqual([{ command: "echo stop" }]);
  });

  it("mcpServers 解析(字符串引用)", () => {
    const raw = `---
name: mcp-agent
description: mcp
mcpServers:
  - slack
---
body`;
    const def = parseAgentDef("mcp-agent", raw);
    expect(def!.mcpServers).toEqual(["slack"]);
  });
});
