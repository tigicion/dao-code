import { describe, it, expect } from "vitest";
import { decide } from "./engine.js";
import { emptyPermissions } from "./settings.js";

const base = { rules: emptyPermissions() };
const rm = '{"command":"rm -rf /"}';

describe("decide — CC 优先级:deny > bypass > ask > allow > 模式/能力默认", () => {
  it("deny 规则永远拦截(即使 bypassPermissions)", () => {
    const rules = { ...emptyPermissions(), deny: ["Bash(rm:*)"] };
    expect(decide({ toolName: "exec_shell", argsJson: rm, capability: "exec", mode: "bypassPermissions", rules })).toBe("deny");
  });
  it("bypassPermissions:无 deny 时一律放行(连 exec 也放行)", () => {
    expect(decide({ toolName: "exec_shell", argsJson: rm, capability: "exec", mode: "bypassPermissions", ...base })).toBe("allow");
  });
  it("ask 规则强制询问(优先于 allow)", () => {
    const rules = { ...emptyPermissions(), allow: ["Bash"], ask: ["Bash(rm:*)"] };
    expect(decide({ toolName: "exec_shell", argsJson: rm, capability: "exec", mode: "default", rules })).toBe("ask");
  });
  it("allow 规则命中放行", () => {
    const rules = { ...emptyPermissions(), allow: ["Bash(npm run test:*)"] };
    expect(decide({ toolName: "exec_shell", argsJson: '{"command":"npm run test"}', capability: "exec", mode: "default", rules })).toBe("allow");
  });
});

describe("decide — 模式默认(无规则命中)", () => {
  it("default:read 自动放行,write/exec 询问", () => {
    expect(decide({ toolName: "read_file", argsJson: '{"path":"a"}', capability: "read", mode: "default", ...base })).toBe("allow");
    expect(decide({ toolName: "exec_shell", argsJson: rm, capability: "exec", mode: "default", ...base })).toBe("ask");
    expect(decide({ toolName: "write_file", argsJson: '{"path":"a"}', capability: "write", mode: "default", ...base })).toBe("ask");
  });
  it("acceptEdits:文件编辑自动放行,exec 仍询问", () => {
    expect(decide({ toolName: "edit_file", argsJson: '{"path":"a"}', capability: "write", mode: "acceptEdits", ...base })).toBe("allow");
    expect(decide({ toolName: "write_file", argsJson: '{"path":"a"}', capability: "write", mode: "acceptEdits", ...base })).toBe("allow");
    expect(decide({ toolName: "exec_shell", argsJson: rm, capability: "exec", mode: "acceptEdits", ...base })).toBe("ask");
  });
  it("plan:有副作用的(write/exec/network)拦截,read 放行", () => {
    expect(decide({ toolName: "exec_shell", argsJson: rm, capability: "exec", mode: "plan", ...base })).toBe("deny");
    expect(decide({ toolName: "write_file", argsJson: '{"path":"a"}', capability: "write", mode: "plan", ...base })).toBe("deny");
    expect(decide({ toolName: "read_file", argsJson: '{"path":"a"}', capability: "read", mode: "plan", ...base })).toBe("allow");
  });
  it("无 CC 对应的工具(plan 能力,如 memory/todo)默认放行", () => {
    expect(decide({ toolName: "memory_write", argsJson: "{}", capability: "plan", mode: "default", ...base })).toBe("allow");
  });
});
