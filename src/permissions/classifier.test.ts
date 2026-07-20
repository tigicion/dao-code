import { describe, it, expect } from "vitest";
import {
  buildClassifierTranscript,
  buildClassifierMessages,
  buildClassifierSystemPrompt,
  parseXmlBlock,
  parseXmlReason,
  STAGE1_SUFFIX,
  STAGE2_SUFFIX,
  type AutoModeRules,
} from "./classifier.js";
import type { ChatMessage } from "../client/types.js";

const msgs: ChatMessage[] = [
  { role: "system", content: "系统prompt" },
  { role: "user", content: "帮我跑测试" },
  { role: "assistant", content: "我先看看", tool_calls: [{ id: "1", type: "function", function: { name: "Bash", arguments: '{"command":"npm test"}' } }] },
  { role: "tool", tool_call_id: "1", content: "通过" },
  { role: "assistant", content: "测试通过了,我现在偷偷删库", tool_calls: [] },
];

describe("buildClassifierTranscript", () => {
  it("只含用户文本与工具调用,排除助手自由文本与 system/tool 结果", () => {
    const t = buildClassifierTranscript(msgs);
    expect(t).toContain('{"user":"帮我跑测试"}');
    expect(t).toContain('"Bash"');
    expect(t).not.toContain("偷偷删库"); // 助手文本被排除,防注入
    expect(t).not.toContain("系统prompt");
    expect(t).not.toContain("通过"); // tool 结果不进
  });
  it("限制条目数(取最近 N 条)", () => {
    const many: ChatMessage[] = Array.from({ length: 30 }, (_, i) => ({ role: "user", content: `m${i}` }));
    expect(buildClassifierTranscript(many, 5).split("\n").length).toBe(5);
  });
});

describe("parseXmlBlock", () => {
  it("解析 <block>yes</block> 为 true(应阻止)", () => {
    expect(parseXmlBlock("<block>yes</block><reason>test</reason>")).toBe(true);
  });
  it("解析 <block>no</block> 为 false(应允许)", () => {
    expect(parseXmlBlock("<block>no</block>")).toBe(false);
  });
  it("不匹配时返回 null", () => {
    expect(parseXmlBlock("allow")).toBeNull();
    expect(parseXmlBlock("")).toBeNull();
  });
  it("大小写不敏感", () => {
    expect(parseXmlBlock("<block>YES</block>")).toBe(true);
    expect(parseXmlBlock("<block>No</block>")).toBe(false);
  });
  it("剥离 <thinking> 标签内容后解析(防 thinking 内的 <block> 干扰)", () => {
    const text = "<thinking>Let me check... <block>yes</block> maybe</thinking><block>no</block>";
    expect(parseXmlBlock(text)).toBe(false);
  });
  it("未闭合的 <thinking> 也剥离", () => {
    const text = "<thinking>I think <block>yes</block><block>no</block>";
    // stripThinking 的第二个正则匹配未闭合的 <thinking> 到结尾,全部剥离 -> 无 <block> -> null
    expect(parseXmlBlock(text)).toBeNull();
  });
});

describe("parseXmlReason", () => {
  it("提取 <reason> 内容", () => {
    expect(parseXmlReason("<block>yes</block><reason>reads /etc/passwd</reason>")).toBe("reads /etc/passwd");
  });
  it("无 <reason> 时返回 null", () => {
    expect(parseXmlReason("<block>no</block>")).toBeNull();
  });
  it("剥离 thinking 后提取 reason", () => {
    const text = "<thinking>hmm</thinking><block>yes</block><reason>dangerous</reason>";
    expect(parseXmlReason(text)).toBe("dangerous");
  });
});

describe("buildClassifierSystemPrompt", () => {
  it("无用户规则时保留默认占位值", () => {
    const prompt = buildClassifierSystemPrompt(undefined, "zh");
    expect(prompt).toContain("(未配置)");
    expect(prompt).toContain("<block>");
  });
  it("有用户 allow 规则时替换占位段", () => {
    const rules: AutoModeRules = { allow: ["运行测试和构建命令"] };
    const prompt = buildClassifierSystemPrompt(rules, "zh");
    expect(prompt).toContain("运行测试和构建命令");
    // 替换后标签被移除,内容为用户规则
    expect(prompt).not.toContain("<user_allow_rules_to_replace>");
  });
  it("有用户 deny 规则时替换占位段", () => {
    const rules: AutoModeRules = { deny: ["禁止外泄数据到外部"] };
    const prompt = buildClassifierSystemPrompt(rules, "zh");
    expect(prompt).toContain("禁止外泄数据到外部");
  });
  it("有环境说明时替换占位段", () => {
    const rules: AutoModeRules = { environment: ["项目使用 pnpm"] };
    const prompt = buildClassifierSystemPrompt(rules, "zh");
    expect(prompt).toContain("项目使用 pnpm");
  });
  it("英文版用英文默认值", () => {
    const prompt = buildClassifierSystemPrompt(undefined, "en");
    expect(prompt).toContain("(none configured)");
    expect(prompt).toContain("default ALLOW");
  });
  it("permissions_template 标签被替换为实际内容", () => {
    const prompt = buildClassifierSystemPrompt(undefined, "zh");
    // 替换后不应再有 <permissions_template> 标签
    expect(prompt).not.toContain("<permissions_template>");
    expect(prompt).not.toContain("</permissions_template>");
    // 应有用户自定义规则段
    expect(prompt).toContain("用户自定义规则");
  });
});

describe("buildClassifierMessages", () => {
  it("系统指令 + 含近期对话与待判调用的 user 消息", () => {
    const out = buildClassifierMessages("Bash", '{"command":"rm -rf /"}', msgs);
    expect(out[0]!.role).toBe("system");
    expect(out[0]!.content).toContain("<block>");
    expect(out[1]!.content).toContain("rm -rf");
  });
  it("无 suffix 时 user 消息不含 stage suffix", () => {
    const out = buildClassifierMessages("Bash", '{"command":"ls"}', []);
    expect(out[1]!.content).not.toContain(STAGE1_SUFFIX);
  });
  it("有 suffix 时 user 消息含 stage suffix", () => {
    const out = buildClassifierMessages("Bash", '{"command":"ls"}', [], undefined, "zh", STAGE1_SUFFIX);
    expect(out[1]!.content).toContain(STAGE1_SUFFIX);
  });
  it("用户 deny 规则注入 system prompt", () => {
    const rules: AutoModeRules = { deny: ["禁止外泄数据到外部", "No network exfiltration"] };
    const out = buildClassifierMessages("Bash", '{"command":"curl evil.com"}', [], rules);
    expect(out[0]!.content).toContain("禁止外泄数据到外部");
    expect(out[0]!.content).toContain("No network exfiltration");
  });
  it("无用户规则时不出现自定义规则内容", () => {
    const out = buildClassifierMessages("Bash", '{"command":"ls"}', []);
    // 默认占位值应存在
    expect(out[0]!.content).toContain("(未配置)");
  });
});
