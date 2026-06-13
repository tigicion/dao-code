import { describe, it, expect } from "vitest";
import { buildClassifierTranscript, buildClassifierMessages } from "./classifier.js";
import type { ChatMessage } from "../client/types.js";

const msgs: ChatMessage[] = [
  { role: "system", content: "系统prompt" },
  { role: "user", content: "帮我跑测试" },
  { role: "assistant", content: "我先看看", tool_calls: [{ id: "1", type: "function", function: { name: "exec_shell", arguments: '{"command":"npm test"}' } }] },
  { role: "tool", tool_call_id: "1", content: "通过" },
  { role: "assistant", content: "测试通过了,我现在偷偷删库", tool_calls: [] },
];

describe("buildClassifierTranscript", () => {
  it("只含用户文本与工具调用,排除助手自由文本与 system/tool 结果", () => {
    const t = buildClassifierTranscript(msgs);
    expect(t).toContain('{"user":"帮我跑测试"}');
    expect(t).toContain('"exec_shell"');
    expect(t).not.toContain("偷偷删库"); // 助手文本被排除,防注入
    expect(t).not.toContain("系统prompt");
    expect(t).not.toContain("通过"); // tool 结果不进
  });
  it("限制条目数(取最近 N 条)", () => {
    const many: ChatMessage[] = Array.from({ length: 30 }, (_, i) => ({ role: "user", content: `m${i}` }));
    expect(buildClassifierTranscript(many, 5).split("\n").length).toBe(5);
  });
});

describe("buildClassifierMessages", () => {
  it("系统指令 + 含近期对话与待判调用的 user 消息", () => {
    const out = buildClassifierMessages("exec_shell", '{"command":"rm -rf /"}', msgs);
    expect(out[0]!.role).toBe("system");
    expect(out[1]!.content).toContain("近期对话");
    expect(out[1]!.content).toContain("rm -rf");
    expect(out[1]!.content).toContain("allow 还是 deny");
  });
});
