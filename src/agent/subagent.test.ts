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

const stubGate: ApprovalGate = { decide: () => "allow", decideAsync: async () => "allow", requestBatch: async () => new Map() };

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

  it("并发多个子代理时,各自的流式输出不会交织成乱码——每个子代理整段一次性 flush", async () => {
    // 根因(真实撞见:protein-assembly 任务并发派发4个子代理):runTurn 内部会话
    // 每来一个 content/reasoning delta 就调一次 write(),多个子代理并发跑时如果直接
    // 共享同一个父级 write() 通道,delta 会逐个交织写入,把两段不相关的文本拼成乱码
    // (真实案例里一段蛋白质序列跟另一段搜索策略描述逐词交错在了一起)。
    // 这里模拟两个并发子代理,runTurn 里各自异步地调多次 write(不同 tick),断言合并后
    // 的输出流里,子代理A的所有 delta 是连续一段、子代理B的所有 delta 也是连续一段,
    // 不会一片A一片B地交替出现。
    const written: string[] = [];
    const sharedWrite = (s: string) => written.push(s);
    const microtask = () => new Promise<void>((r) => queueMicrotask(r));

    await Promise.all([
      runSubagent(baseDeps({
        write: sharedWrite,
        runTurn: async (deps) => {
          for (const d of ["一", "二", "三", "四"]) {
            await microtask(); // 交替让出控制权,模拟真实并发流式的时序交错
            deps.write(`A:${d} `);
          }
          deps.session.messages.push({ role: "assistant", content: "A结果" });
        },
      })),
      runSubagent(baseDeps({
        write: sharedWrite,
        runTurn: async (deps) => {
          for (const d of ["壹", "贰", "叁", "肆"]) {
            await microtask();
            deps.write(`B:${d} `);
          }
          deps.session.messages.push({ role: "assistant", content: "B结果" });
        },
      })),
    ]);

    const flat = written.join("");
    // 断言:A 的四个 delta 在输出里是连续粘在一起的一段(中间没有插入 B 的内容),B 同理。
    // 用正则抓 "A:一 A:二 A:三 A:四 " 这种连续块是否作为一个整体出现在输出里。
    expect(flat).toContain("A:一 A:二 A:三 A:四 ");
    expect(flat).toContain("B:壹 B:贰 B:叁 B:肆 ");
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
