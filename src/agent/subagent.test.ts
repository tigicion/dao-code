import { describe, it, expect } from "vitest";
import { runSubagent, type SubagentDeps } from "./subagent.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ApprovalGate } from "../approval/types.js";
import type { TurnDeps } from "./loop.js";
import type { ChatMessage } from "../client/types.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCacheAuditSink } from "../session/cache_audit.js";

const stubGate: ApprovalGate = { decide: () => "allow", requestBatch: async () => new Map() };

function baseDeps(overrides: Partial<SubagentDeps>): SubagentDeps {
  return {
    task: "do X",
    systemPrompt: "SUB SYS",
    model: "deepseek-v4-pro",
    mode: "normal",
    config: { baseUrl: "", apiKey: "" },
    registry: new ToolRegistry(),
    ctx: { workspaceRoot: "/tmp" },
    gate: stubGate,
    streamChat: (() => {}) as unknown as TurnDeps["streamChat"],
    executeToolCalls: async () => [],
    write: () => {},
    runTurn: async () => {},
    ...overrides,
  };
}

describe("runSubagent", () => {
  it("runs the task on a fresh session and returns the final assistant content", async () => {
    const written: string[] = [];
    const result = await runSubagent(
      baseDeps({
        write: (s) => written.push(s),
        runTurn: async (deps) => {
          expect(deps.session.messages.map((m) => m.role)).toEqual(["system", "user"]);
          deps.session.messages.push({ role: "assistant", content: "子代理结果" });
        },
      }),
    );
    expect(result).toBe("子代理结果");
    expect(written.join("")).toContain("子代理开始");
    expect(written.join("")).toContain("子代理完成");
  });

  it("increments subagentDepth in the sub-ctx passed to runTurn", async () => {
    let seenDepth: number | undefined;
    await runSubagent(
      baseDeps({
        ctx: { workspaceRoot: "/tmp", subagentDepth: 0 },
        runTurn: async (deps) => {
          seenDepth = deps.ctx.subagentDepth;
          deps.session.messages.push({ role: "assistant", content: "x" });
        },
      }),
    );
    expect(seenDepth).toBe(1);
  });

  it("inherits the given mode", async () => {
    let seenMode: string | undefined;
    await runSubagent(
      baseDeps({
        mode: "plan",
        runTurn: async (deps) => {
          seenMode = deps.session.mode;
          deps.session.messages.push({ role: "assistant", content: "x" });
        },
      }),
    );
    expect(seenMode).toBe("plan");
  });

  it("returns a placeholder when there is no assistant output", async () => {
    const result = await runSubagent(baseDeps({ runTurn: async () => {} }));
    expect(result).toContain("无最终输出");
  });

  it("forwards the audit sink with sub identity (agent/subId/depth) into runTurn", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sub-ca-"));
    const sink = createCacheAuditSink(dir, {});
    let captured: TurnDeps | undefined;
    await runSubagent(
      baseDeps({
        ctx: { workspaceRoot: "/tmp", subagentDepth: 0 },
        auditSink: sink,
        auditAgent: "sub",
        auditSubId: "zz",
        runTurn: async (deps) => {
          captured = deps;
          deps.session.messages.push({ role: "assistant", content: "x" });
        },
      }),
    );
    expect(captured?.auditSink).toBe(sink);
    expect(captured?.auditId?.agent).toBe("sub");
    expect(captured?.auditId?.subId).toBe("zz");
    expect(captured?.auditId?.depth).toBe(1); // ctx.subagentDepth(0)+1
  });
});

describe("Part A 缓存安全(fork 前缀不被改 / 普通子代理独立前缀)", () => {
  // fork 的价值是复用父代理已缓存的消息前缀:前缀必须 byte 不变、只在末尾追加一条 user。
  it("fork:父前缀逐条 byte 相等 + 只在末尾追加一条 user(append-only,保持缓存命中)", async () => {
    const fork: ChatMessage[] = [
      { role: "system", content: "PARENT SYS" },
      { role: "user", content: "父任务问题" },
      { role: "assistant", content: "父代理答复" },
    ];
    let captured: ChatMessage[] | undefined;
    await runSubagent(
      baseDeps({
        task: "FORK 子任务",
        forkMessages: fork,
        runTurn: async (deps) => {
          // 复制一份快照:断言子代理跑起来时 session 的前缀,而非事后被改的引用。
          captured = deps.session.messages.map((m) => ({ ...m }));
          deps.session.messages.push({ role: "assistant", content: "x" });
        },
      }),
    );
    expect(captured).toBeDefined();
    // 前 3 条 = 父前缀,逐条 byte 相等(深比较),且引用上是同一对象数组复制——内容完全一致。
    expect(captured!.slice(0, 3)).toEqual(fork);
    // 恰好追加了 1 条:总长 4,最后一条是 user(fork 子任务指令),且包含 task 文本。
    expect(captured).toHaveLength(4);
    expect(captured![3]!.role).toBe("user");
    expect(captured![3]!.content).toContain("FORK 子任务");
    // 前缀里没有混入这条追加的 user → append-only,前缀确实没被改写。
    expect(captured!.slice(0, 3).some((m) => m.role === "user" && String(m.content).includes("FORK 子任务"))).toBe(false);
  });

  // 普通(可被 model 覆盖的)子代理:必须自建前缀,绝不接触父代理的 forkMessages 前缀。
  it("普通子代理:不含任何父 fork 前缀,自建 system+task 前缀", async () => {
    const parentPrefix: ChatMessage[] = [
      { role: "system", content: "PARENT SYS" },
      { role: "user", content: "父任务问题" },
      { role: "assistant", content: "父代理答复" },
    ];
    let captured: ChatMessage[] | undefined;
    await runSubagent(
      baseDeps({
        task: "独立子任务",
        systemPrompt: "SUB SYS",
        // 注意:不传 forkMessages —— 普通子代理应忽略父前缀,自建会话。
        runTurn: async (deps) => {
          captured = deps.session.messages.map((m) => ({ ...m }));
          deps.session.messages.push({ role: "assistant", content: "x" });
        },
      }),
    );
    expect(captured).toBeDefined();
    // 自建前缀:恰好 system(SUB SYS)+ user(task),不继承父 model/前缀。
    expect(captured).toEqual([
      { role: "system", content: "SUB SYS" },
      { role: "user", content: "独立子任务" },
    ]);
    // 父前缀的任何一条内容都不应出现在子代理会话里(没有触碰父缓存前缀)。
    for (const pm of parentPrefix) {
      expect(captured!.some((m) => m.role === pm.role && m.content === pm.content)).toBe(false);
    }
  });
});
