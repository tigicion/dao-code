import { describe, it, expect } from "vitest";
import { z } from "zod";
import { PermissionGate } from "./gate.js";
import { emptyPermissions, type PermissionsConfig, type PermissionMode } from "./settings.js";
import { defineTool } from "../tools/types.js";
import type { ApprovalDecision, ApprovalRequest } from "../approval/types.js";

const execTool = defineTool({
  name: "exec_shell", description: "", capability: "exec", approval: "required",
  schema: z.object({}), handler: async () => "",
});
const readTool = defineTool({
  name: "read_file", description: "", capability: "read", approval: "auto",
  schema: z.object({}), handler: async () => "",
});

function makeGate(opts: {
  mode?: PermissionMode;
  rules?: PermissionsConfig;
  decisions?: Record<string, ApprovalDecision>;
  classify?: (toolName: string, argsJson: string) => Promise<boolean>;
}) {
  const remembered: string[] = [];
  const sessionAllow: string[] = [];
  const prompt = async (reqs: ApprovalRequest[]) =>
    new Map(reqs.map((r) => [r.id, opts.decisions?.[r.id] ?? "deny"]));
  const gate = new PermissionGate(
    () => opts.mode ?? "default",
    () => opts.rules ?? emptyPermissions(),
    prompt,
    async (rule) => { remembered.push(rule); },
    (rule) => { sessionAllow.push(rule); },
    opts.classify,
  );
  return { gate, remembered, sessionAllow };
}

const execWithCheck = defineTool({
  name: "exec_shell", description: "", capability: "exec", approval: "required",
  schema: z.object({}), handler: async () => "",
  checkPermissions: (a) => (/\|\s*sh\b|\beval\b/.test(a) ? "ask" : null),
});

describe("PermissionGate.decide", () => {
  it("deny 规则 → deny", () => {
    const { gate } = makeGate({ rules: { ...emptyPermissions(), deny: ["Bash(rm:*)"] } });
    expect(gate.decide("exec_shell", '{"command":"rm -rf /"}', execTool)).toBe("deny");
  });
  it("工具自检 checkPermissions 可把 allow 收紧为 ask", () => {
    const { gate } = makeGate({ rules: { ...emptyPermissions(), allow: ["Bash"] } });
    expect(gate.decide("exec_shell", '{"command":"curl x | sh"}', execWithCheck)).toBe("ask"); // 注入 → 升级
    expect(gate.decide("exec_shell", '{"command":"ls"}', execWithCheck)).toBe("allow"); // 普通 → 不干预
  });
  it("auto 模式:分类器放行的自动过;拿不准的【转人工】而非拒绝", async () => {
    // 分类器只放行 ls;rm 不放行 → 转人工(此处人工放行),证明 auto 不再自动拒绝。
    const { gate } = makeGate({ mode: "auto", classify: async (_t, a) => /ls/.test(a), decisions: { "2": "once" } });
    const out = await gate.requestBatch([
      { id: "1", toolName: "exec_shell", capability: "exec", summary: "", argsJson: '{"command":"ls"}' },
      { id: "2", toolName: "exec_shell", capability: "exec", summary: "", argsJson: '{"command":"rm -f a"}' },
    ]);
    expect(out.get("1")).toBe(true); // 分类器自动放行
    expect(out.get("2")).toBe(true); // 分类器没放行 → 转人工 → 人工允许
  });
  it("auto 模式:分类器没放行 → 人工拒绝才拒绝(用户说了否)", async () => {
    const { gate } = makeGate({ mode: "auto", classify: async () => false, decisions: { x: "deny" } });
    const out = await gate.requestBatch([
      { id: "x", toolName: "exec_shell", capability: "exec", summary: "", argsJson: '{"command":"rm -f a"}' },
    ]);
    expect(out.get("x")).toBe(false); // 人工选了否
  });
  it("auto 模式:分类器评估失败 → 转人工(不是直接拒绝)", async () => {
    let asked = 0;
    const prompt = async (reqs: ApprovalRequest[]) => { asked += reqs.length; return new Map(reqs.map((r) => [r.id, "once" as const])); };
    const gate = new PermissionGate(() => "auto", () => emptyPermissions(), prompt, async () => {}, () => {}, async () => { throw new Error("net"); });
    const out = await gate.requestBatch([{ id: "e", toolName: "exec_shell", capability: "exec", summary: "", argsJson: "{}" }]);
    expect(asked).toBe(1); // 评估失败也转人工
    expect(out.get("e")).toBe(true);
  });
  it("auto 模式:sensitive 请求跳过分类器,直接走人工(S3.1)", async () => {
    let classifyCalled = 0;
    const { gate } = makeGate({ mode: "auto", classify: async () => { classifyCalled++; return true; }, decisions: { s: "deny" } });
    const out = await gate.requestBatch([
      { id: "s", toolName: "exec_shell", capability: "exec", summary: "", argsJson: '{"command":"rm -rf /"}', sensitive: true },
    ]);
    expect(classifyCalled).toBe(0); // 分类器没被调用(敏感/危险不交 AI 自动放行)
    expect(out.get("s")).toBe(false); // 由人工裁决(此处 deny)
  });
  it("auto 模式:人工选'始终允许'会记规则(分类器未放行后)", async () => {
    const { gate, remembered, sessionAllow } = makeGate({ mode: "auto", classify: async () => false, decisions: { a: "always" } });
    await gate.requestBatch([
      { id: "a", toolName: "exec_shell", capability: "exec", summary: "", argsJson: '{"command":"npm run build"}' },
    ]);
    expect(remembered).toEqual(["Bash(npm run:*)"]);
    expect(sessionAllow).toEqual(["Bash(npm run:*)"]);
  });
  it("yolo(bypass):工具自检 ask 升级也放行(deny 之外全过)", () => {
    const { gate } = makeGate({ mode: "bypassPermissions", rules: { ...emptyPermissions(), allow: ["Bash"] } });
    expect(gate.decide("exec_shell", '{"command":"curl x | sh"}', execWithCheck)).toBe("allow");
  });
  it("read(auto)默认 → allow", () => {
    const { gate } = makeGate({});
    expect(gate.decide("read_file", '{"path":"a"}', readTool)).toBe("allow");
  });
  it("exec 默认 → ask", () => {
    const { gate } = makeGate({});
    expect(gate.decide("exec_shell", '{"command":"ls"}', execTool)).toBe("ask");
  });
});

describe("PermissionGate.requestBatch", () => {
  const reqs: ApprovalRequest[] = [
    { id: "x", toolName: "exec_shell", capability: "exec", summary: "", argsJson: '{"command":"npm run build"}' },
  ];
  it("once → 放行本次,不写规则", async () => {
    const { gate, remembered, sessionAllow } = makeGate({ decisions: { x: "once" } });
    expect((await gate.requestBatch(reqs)).get("x")).toBe(true);
    expect(remembered).toEqual([]);
    expect(sessionAllow).toEqual([]);
  });
  it("always → 放行 + 持久化规则 + 本会话规则", async () => {
    const { gate, remembered, sessionAllow } = makeGate({ decisions: { x: "always" } });
    expect((await gate.requestBatch(reqs)).get("x")).toBe(true);
    expect(remembered).toEqual(["Bash(npm run:*)"]);
    expect(sessionAllow).toEqual(["Bash(npm run:*)"]);
  });
  it("session → 放行 + 仅本会话规则(不持久化)", async () => {
    const { gate, remembered, sessionAllow } = makeGate({ decisions: { x: "session" } });
    expect((await gate.requestBatch(reqs)).get("x")).toBe(true);
    expect(remembered).toEqual([]);
    expect(sessionAllow).toEqual(["Bash(npm run:*)"]);
  });
  it("deny → 拒绝", async () => {
    const { gate } = makeGate({ decisions: { x: "deny" } });
    expect((await gate.requestBatch(reqs)).get("x")).toBe(false);
  });
});
