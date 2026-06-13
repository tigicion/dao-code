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
