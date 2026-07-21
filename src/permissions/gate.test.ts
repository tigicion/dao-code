import { describe, it, expect } from "vitest";
import { z } from "zod";
import { PermissionGate } from "./gate.js";
import { emptyPermissions, type PermissionsConfig, type PermissionMode } from "./settings.js";
import { defineTool } from "../tools/types.js";
import type { ApprovalDecision, ApprovalRequest } from "../approval/types.js";
import type { ChatMessage } from "../client/types.js";

const execTool = defineTool({
  name: "Bash", description: "", capability: "exec", approval: "required",
  schema: z.object({}), handler: async () => "",
});
const readTool = defineTool({
  name: "Read", description: "", capability: "read", approval: "auto",
  schema: z.object({}), handler: async () => "",
});

function makeGate(opts: {
  mode?: PermissionMode;
  rules?: PermissionsConfig;
  decisions?: Record<string, ApprovalDecision>;
  classify?: (toolName: string, argsJson: string, recentMessages: ChatMessage[]) => Promise<boolean>;
  getMessages?: () => ChatMessage[];
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
    opts.getMessages,
  );
  return { gate, remembered, sessionAllow };
}

const execWithCheck = defineTool({
  name: "Bash", description: "", capability: "exec", approval: "required",
  schema: z.object({}), handler: async () => "",
  checkPermissions: (a) => (/\|\s*sh\b|\beval\b/.test(a) ? "ask" : null),
});

describe("PermissionGate.decide", () => {
  it("deny 规则 → deny", () => {
    const { gate } = makeGate({ rules: { ...emptyPermissions(), deny: ["Bash(rm:*)"] } });
    expect(gate.decide("Bash", '{"command":"rm -rf /"}', execTool)).toBe("deny");
  });
  it("工具自检 checkPermissions 可把 allow 收紧为 ask", () => {
    const { gate } = makeGate({ rules: { ...emptyPermissions(), allow: ["Bash"] } });
    expect(gate.decide("Bash", '{"command":"curl x | sh"}', execWithCheck)).toBe("ask"); // 注入 → 升级
    expect(gate.decide("Bash", '{"command":"ls"}', execWithCheck)).toBe("allow"); // 普通 → 不干预
  });
  it("auto 模式:分类器放行的自动过;拿不准的【转人工】而非拒绝", async () => {
    // 分类器只放行 ls;rm 不放行 → 转人工(此处人工放行),证明 auto 不再自动拒绝。
    const { gate } = makeGate({ mode: "auto", classify: async (_t, a) => /ls/.test(a), decisions: { "2": "once" } });
    const out = await gate.requestBatch([
      { id: "1", toolName: "Bash", capability: "exec", summary: "", argsJson: '{"command":"ls"}' },
      { id: "2", toolName: "Bash", capability: "exec", summary: "", argsJson: '{"command":"rm -f a"}' },
    ]);
    expect(out.get("1")).toBe(true); // 分类器自动放行
    expect(out.get("2")).toBe(true); // 分类器没放行 → 转人工 → 人工允许
  });
  it("auto 模式:分类器没放行 → 人工拒绝才拒绝(用户说了否)", async () => {
    const { gate } = makeGate({ mode: "auto", classify: async () => false, decisions: { x: "deny" } });
    const out = await gate.requestBatch([
      { id: "x", toolName: "Bash", capability: "exec", summary: "", argsJson: '{"command":"rm -f a"}' },
    ]);
    expect(out.get("x")).toBe(false); // 人工选了否
  });
  it("auto 模式:分类器评估失败 → 转人工(不是直接拒绝)", async () => {
    let asked = 0;
    const prompt = async (reqs: ApprovalRequest[]) => { asked += reqs.length; return new Map(reqs.map((r) => [r.id, "once" as const])); };
    const gate = new PermissionGate(() => "auto", () => emptyPermissions(), prompt, async () => {}, () => {}, async () => { throw new Error("net"); });
    const out = await gate.requestBatch([{ id: "e", toolName: "Bash", capability: "exec", summary: "", argsJson: "{}" }]);
    expect(asked).toBe(1); // 评估失败也转人工
    expect(out.get("e")).toBe(true);
  });
  it("auto 模式:sensitive 请求跳过分类器,直接走人工(S3.1)", async () => {
    let classifyCalled = 0;
    const { gate } = makeGate({ mode: "auto", classify: async () => { classifyCalled++; return true; }, decisions: { s: "deny" } });
    const out = await gate.requestBatch([
      { id: "s", toolName: "Bash", capability: "exec", summary: "", argsJson: '{"command":"rm -rf /"}', sensitive: true },
    ]);
    expect(classifyCalled).toBe(0); // 分类器没被调用(敏感/危险不交 AI 自动放行)
    expect(out.get("s")).toBe(false); // 由人工裁决(此处 deny)
  });
  it("auto 模式:人工选'始终允许'会记规则(分类器未放行后)", async () => {
    const { gate, remembered, sessionAllow } = makeGate({ mode: "auto", classify: async () => false, decisions: { a: "always" } });
    await gate.requestBatch([
      { id: "a", toolName: "Bash", capability: "exec", summary: "", argsJson: '{"command":"npm run build"}' },
    ]);
    expect(remembered).toEqual(["Bash(npm run:*)"]);
    expect(sessionAllow).toEqual(["Bash(npm run:*)"]);
  });
  it("yolo(bypass):工具自检 ask 升级也放行(deny 之外全过)", () => {
    const { gate } = makeGate({ mode: "bypassPermissions", rules: { ...emptyPermissions(), allow: ["Bash"] } });
    expect(gate.decide("Bash", '{"command":"curl x | sh"}', execWithCheck)).toBe("allow");
  });
  it("read(auto)默认 → allow", () => {
    const { gate } = makeGate({});
    expect(gate.decide("Read", '{"path":"a"}', readTool)).toBe("allow");
  });
  it("exec 默认 → ask(非只读命令;纯只读命令如 ls 现在走只读快速路径直接 allow,见 engine.test.ts)", () => {
    const { gate } = makeGate({});
    expect(gate.decide("Bash", '{"command":"npm install"}', execTool)).toBe("ask");
  });
});

describe("PermissionGate.withModeOverride", () => {
  // 参考:子代理用 agentDef.permissionMode 裁决,而非继承父级 session 的 mode。
  // 此前 dao 子代理和父级共用同一个 gate,gate.getMode() 返回父级 mode,
  // 导致子代理的 permissionMode 设了也没用。
  const writeTool = defineTool({
    name: "Write", description: "", capability: "write", approval: "required",
    schema: z.object({}), handler: async () => "",
  });

  it("父级 default -> 子代理 acceptEdits:write 从 ask 变 allow", () => {
    const { gate } = makeGate({ mode: "default" });
    expect(gate.decide("Write", '{"path":"a.ts"}', writeTool)).toBe("ask");
    const subGate = gate.withModeOverride("acceptEdits");
    expect(subGate.decide("Write", '{"path":"a.ts"}', writeTool)).toBe("allow");
  });

  it("父级 default -> 子代理 plan:write 从 ask 变 deny", () => {
    const { gate } = makeGate({ mode: "default" });
    const subGate = gate.withModeOverride("plan");
    expect(subGate.decide("Write", '{"path":"a.ts"}', writeTool)).toBe("deny");
  });

  it("父级 acceptEdits -> 子代理 plan:read 仍 allow", () => {
    const { gate } = makeGate({ mode: "acceptEdits" });
    const subGate = gate.withModeOverride("plan");
    expect(subGate.decide("Read", '{"path":"a.ts"}', readTool)).toBe("allow");
  });

  it("classify 收到的是当前 gate 绑定的 getMessages(),而不是固定写死的空数组", async () => {
    // 根因(session 20260721-215548-uq75):此前 classify 闭包永久绑定根 session.messages,
    // withModeOverride 只换 mode 不换 transcript 来源,子代理的调用被父级(甚至无关的)对话历史
    // 判定——分类器看不到子代理自己在做什么,"相关性"判断必然失真。
    const received: ChatMessage[][] = [];
    const rootMessages: ChatMessage[] = [{ role: "user", content: "根会话消息" }];
    const { gate } = makeGate({
      mode: "auto",
      classify: async (_t, _a, messages) => { received.push(messages); return true; },
      getMessages: () => rootMessages,
    });
    await gate.requestBatch([
      { id: "x", toolName: "Bash", capability: "exec", summary: "", argsJson: '{"command":"npm run typecheck"}' },
    ]);
    expect(received[0]).toBe(rootMessages);
  });

  it("withModeOverride 传入新的 getMessages 后,子 gate 的 classify 用子级 transcript,不再是父级的", async () => {
    const received: ChatMessage[][] = [];
    const rootMessages: ChatMessage[] = [{ role: "user", content: "父级消息" }];
    const subMessages: ChatMessage[] = [{ role: "system", content: "子代理系统提示" }, { role: "user", content: "子代理任务" }];
    const { gate } = makeGate({
      mode: "default", // 父级 mode 不影响,withModeOverride 会换成 auto
      classify: async (_t, _a, messages) => { received.push(messages); return true; },
      getMessages: () => rootMessages,
    });
    const subGate = gate.withModeOverride("auto", () => subMessages);
    await subGate.requestBatch([
      { id: "x", toolName: "Bash", capability: "exec", summary: "", argsJson: '{"command":"npm run typecheck"}' },
    ]);
    expect(received[0]).toBe(subMessages);
    expect(received[0]).not.toBe(rootMessages);
  });

  it("withModeOverride 不传 getMessages 时,子 gate 沿用父级的(向后兼容)", async () => {
    const received: ChatMessage[][] = [];
    const rootMessages: ChatMessage[] = [{ role: "user", content: "父级消息" }];
    const { gate } = makeGate({
      mode: "default",
      classify: async (_t, _a, messages) => { received.push(messages); return true; },
      getMessages: () => rootMessages,
    });
    const subGate = gate.withModeOverride("auto");
    await subGate.requestBatch([
      { id: "x", toolName: "Bash", capability: "exec", summary: "", argsJson: '{"command":"npm run typecheck"}' },
    ]);
    expect(received[0]).toBe(rootMessages);
  });

  it("子 gate 的 requestBatch 复用父级的 prompt/remember", async () => {
    const remembered: string[] = [];
    const sessionAllow: string[] = [];
    const prompt = async (reqs: ApprovalRequest[]) =>
      new Map(reqs.map((r) => [r.id, "always" as const]));
    const parent = new PermissionGate(
      () => "default",
      () => emptyPermissions(),
      prompt,
      async (rule) => { remembered.push(rule); },
      (rule) => { sessionAllow.push(rule); },
    );
    const sub = parent.withModeOverride("default");
    await sub.requestBatch([
      { id: "x", toolName: "Bash", capability: "exec", summary: "", argsJson: '{"command":"npm run build"}' },
    ]);
    expect(remembered).toEqual(["Bash(npm run:*)"]);
    expect(sessionAllow).toEqual(["Bash(npm run:*)"]);
  });
});

describe("PermissionGate.requestBatch", () => {
  const reqs: ApprovalRequest[] = [
    { id: "x", toolName: "Bash", capability: "exec", summary: "", argsJson: '{"command":"npm run build"}' },
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

describe("PermissionGate.lastApprovalSource", () => {
  // 复盘 20260719-194639-mal7 时发现 perm-trace 把"分类器自动放行"和"真人点了允许"记成
  // 同一个 "ask",没法回答"到底打扰了几次人"。这里验证补上的归因是否准确。
  it("分类器放行的记 classifier,转人工的记 human,互不干扰", async () => {
    const { gate } = makeGate({
      mode: "auto",
      classify: async (_t, a) => /ls/.test(a), // 只放行含 ls 的
      decisions: { needsHuman: "once" },
    });
    await gate.requestBatch([
      { id: "byClassifier", toolName: "Bash", capability: "exec", summary: "", argsJson: '{"command":"ls"}' },
      { id: "needsHuman", toolName: "Bash", capability: "exec", summary: "", argsJson: '{"command":"rm -f a"}' },
    ]);
    expect(gate.lastApprovalSource("byClassifier")).toBe("classifier");
    expect(gate.lastApprovalSource("needsHuman")).toBe("human");
  });

  it("敏感请求跳过分类器直接转人工 → 记 human", async () => {
    const { gate } = makeGate({
      mode: "auto",
      classify: async () => true,
      decisions: { s: "once" },
    });
    await gate.requestBatch([
      { id: "s", toolName: "Bash", capability: "exec", summary: "", argsJson: '{"command":"rm -rf /"}', sensitive: true },
    ]);
    expect(gate.lastApprovalSource("s")).toBe("human");
  });

  it("default 模式(没有分类器介入)→ 全部记 human", async () => {
    const { gate } = makeGate({ mode: "default", decisions: { x: "once" } });
    await gate.requestBatch([{ id: "x", toolName: "Bash", capability: "exec", summary: "", argsJson: '{"command":"npm run build"}' }]);
    expect(gate.lastApprovalSource("x")).toBe("human");
  });

  it("只反映最近一批,换一批就清空旧的归因", async () => {
    const { gate } = makeGate({ mode: "auto", classify: async () => true, decisions: {} });
    await gate.requestBatch([{ id: "a", toolName: "Bash", capability: "exec", summary: "", argsJson: '{"command":"ls"}' }]);
    expect(gate.lastApprovalSource("a")).toBe("classifier");
    await gate.requestBatch([{ id: "b", toolName: "Bash", capability: "exec", summary: "", argsJson: '{"command":"ls"}' }]);
    expect(gate.lastApprovalSource("a")).toBeUndefined(); // 上一批的痕迹被清掉
    expect(gate.lastApprovalSource("b")).toBe("classifier");
  });
});

describe("PermissionGate 熔断(denial tracking)", () => {
  it("连续 3 次 deny 后熔断,后续请求跳过分类器直接转人工", async () => {
    let classifyCalls = 0;
    const { gate } = makeGate({
      mode: "auto",
      classify: async () => { classifyCalls++; return false; }, // 总是 deny
      decisions: { a: "once", b: "once", c: "once", d: "once", e: "once" },
    });
    // 前 3 次:分类器被调用,deny -> 转人工
    for (const id of ["a", "b", "c"]) {
      await gate.requestBatch([{ id, toolName: "Bash", capability: "exec", summary: "", argsJson: '{"command":"ls"}' }]);
    }
    expect(classifyCalls).toBe(3);
    // 第 4 次:熔断,分类器不再被调用,直接转人工
    await gate.requestBatch([{ id: "d", toolName: "Bash", capability: "exec", summary: "", argsJson: '{"command":"ls"}' }]);
    expect(classifyCalls).toBe(3); // 没有增加
    expect(gate.lastApprovalSource("d")).toBe("human");
  });

  it("分类器 allow 重置连续 deny 计数(不熔断)", async () => {
    let classifyCalls = 0;
    const results = [false, false, true, false, false, false];
    const { gate } = makeGate({
      mode: "auto",
      classify: async () => { const r = results[classifyCalls] ?? false; classifyCalls++; return r; },
      decisions: { a: "once", b: "once", c: "once", d2: "once", e2: "once", f2: "once", g2: "once" },
    });
    // a,b: deny (连续=2), c: allow (连续重置为0), d2,e2,f2: deny (连续=3, 熔断)
    await gate.requestBatch([{ id: "a", toolName: "Bash", capability: "exec", summary: "", argsJson: '{"command":"ls"}' }]);
    await gate.requestBatch([{ id: "b", toolName: "Bash", capability: "exec", summary: "", argsJson: '{"command":"ls"}' }]);
    await gate.requestBatch([{ id: "c", toolName: "Bash", capability: "exec", summary: "", argsJson: '{"command":"ls"}' }]);
    expect(gate.lastApprovalSource("c")).toBe("classifier"); // allow
    await gate.requestBatch([{ id: "d2", toolName: "Bash", capability: "exec", summary: "", argsJson: '{"command":"ls"}' }]);
    await gate.requestBatch([{ id: "e2", toolName: "Bash", capability: "exec", summary: "", argsJson: '{"command":"ls"}' }]);
    await gate.requestBatch([{ id: "f2", toolName: "Bash", capability: "exec", summary: "", argsJson: '{"command":"ls"}' }]);
    // f2 是第 3 次连续 deny -> 熔断
    expect(classifyCalls).toBe(6);
    // g2: 熔断,不调分类器
    await gate.requestBatch([{ id: "g2", toolName: "Bash", capability: "exec", summary: "", argsJson: '{"command":"ls"}' }]);
    expect(classifyCalls).toBe(6); // 没增加
    expect(gate.lastApprovalSource("g2")).toBe("human");
  });

  it("熔断触发时 consumeTripNotice() 一次性返回通知,消费后清空", async () => {
    // 根因(session 20260721-215548-uq75):熔断后 DAO 静默降级到全人工,30 分钟后静默恢复,
    // 用户完全不知道 auto 模式已经名存实亡——只能靠"怎么老问我"的困惑反推,而不是被明确告知。
    const { gate } = makeGate({
      mode: "auto",
      classify: async () => false, // 总是 deny
      decisions: { a: "once", b: "once", c: "once", d: "once" },
    });
    expect(gate.consumeTripNotice()).toBeNull(); // 还没触发
    await gate.requestBatch([{ id: "a", toolName: "Bash", capability: "exec", summary: "", argsJson: '{"command":"ls"}' }]);
    expect(gate.consumeTripNotice()).toBeNull(); // 连续 1 次,还没到阈值
    await gate.requestBatch([{ id: "b", toolName: "Bash", capability: "exec", summary: "", argsJson: '{"command":"ls"}' }]);
    expect(gate.consumeTripNotice()).toBeNull(); // 连续 2 次,还没到阈值
    await gate.requestBatch([{ id: "c", toolName: "Bash", capability: "exec", summary: "", argsJson: '{"command":"ls"}' }]);
    expect(gate.consumeTripNotice()).toEqual({ consecutiveDenials: 3, totalDenials: 3 }); // 第 3 次:刚好触发
    expect(gate.consumeTripNotice()).toBeNull(); // 消费后清空,不重复通知同一次熔断
    // 第 4 次请求仍处于熔断状态(已在上一条用例验证 classifyCalls 不再增加),但不应产生新的通知
    await gate.requestBatch([{ id: "d", toolName: "Bash", capability: "exec", summary: "", argsJson: '{"command":"ls"}' }]);
    expect(gate.consumeTripNotice()).toBeNull();
  });
});
