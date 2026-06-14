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
  it("auto 模式:requestBatch 用分类器裁决(不弹人工)", async () => {
    const { gate } = makeGate({ mode: "auto", classify: async (_t, a) => !/rm/.test(a) });
    const out = await gate.requestBatch([
      { id: "1", toolName: "exec_shell", capability: "exec", summary: "", argsJson: '{"command":"ls"}' },
      { id: "2", toolName: "exec_shell", capability: "exec", summary: "", argsJson: '{"command":"rm -rf /"}' },
    ]);
    expect(out.get("1")).toBe(true); // 分类器放行
    expect(out.get("2")).toBe(false); // 分类器拒绝
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
  it("auto 模式:连续拒绝 3 次后回退人工审批", async () => {
    // 分类器一律拒绝;第 4 次起应改由 prompt(人工)裁决 —— 这里人工放行。
    const { gate } = makeGate({ mode: "auto", classify: async () => false, decisions: { "4": "once" } });
    const mk = (id: string): ApprovalRequest => ({ id, toolName: "exec_shell", capability: "exec", summary: "", argsJson: "{}" });
    for (const id of ["1", "2", "3"]) {
      const out = await gate.requestBatch([mk(id)]);
      expect(out.get(id)).toBe(false); // 分类器拒绝
    }
    const out4 = await gate.requestBatch([mk("4")]); // 连续 3 次后 → 回退人工(放行)
    expect(out4.get("4")).toBe(true);
  });
  it("auto 拒绝带准确来源:分类器判定拒绝 → denialReason 说明非用户拒绝", async () => {
    const { gate } = makeGate({ mode: "auto", classify: async () => false });
    const out = await gate.requestBatch([
      { id: "g", toolName: "exec_shell", capability: "exec", summary: "", argsJson: '{"command":"git init"}' },
    ]);
    expect(out.get("g")).toBe(false);
    expect(gate.denialReason("g")).toContain("并非你手动拒绝");
    expect(gate.denialReason("g")).not.toContain("评估失败");
  });
  it("auto 拒绝带准确来源:分类器调用失败 → denialReason 标记评估失败", async () => {
    const { gate } = makeGate({ mode: "auto", classify: async () => { throw new Error("network"); } });
    const out = await gate.requestBatch([
      { id: "e", toolName: "exec_shell", capability: "exec", summary: "", argsJson: '{"command":"git init"}' },
    ]);
    expect(out.get("e")).toBe(false);
    expect(gate.denialReason("e")).toContain("评估失败");
  });
  it("人工拒绝不算 auto 来源:denialReason 为空(回灌默认'用户拒绝')", async () => {
    // sensitive → 走人工;人工 deny 是真正的用户拒绝,不应带 auto reason。
    const { gate } = makeGate({ mode: "auto", classify: async () => true, decisions: { s: "deny" } });
    await gate.requestBatch([
      { id: "s", toolName: "exec_shell", capability: "exec", summary: "", argsJson: '{"command":"rm -rf /"}', sensitive: true },
    ]);
    expect(gate.denialReason("s")).toBeUndefined();
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
