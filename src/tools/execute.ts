import type { ToolCall, ToolMessage } from "../client/types.js";
import type { Capability, ToolContext } from "./types.js";
import type { ToolRegistry } from "./registry.js";
import type { ApprovalGate, ApprovalRequest } from "../approval/types.js";

// 并发安全(对标 CC 的 isConcurrencySafe):只读/网络/plan 类不改工作区文件、无副作用顺序问题 → 可并行;
// write/exec 改文件或有外部副作用 → 作"屏障":独占执行,不与任何工具并发(防 race / 不确定状态)。
const SAFE_CAPS = new Set<Capability>(["read", "network", "plan"]);
const MAX_CONCURRENCY = 8; // 安全工具批的并发上限,避免一口气打满 fd / 连接

async function dispatchOne(
  tc: ToolCall,
  registry: ToolRegistry,
  ctx: ToolContext,
): Promise<ToolMessage> {
  const name = tc.function.name;
  const argsJson = tc.function.arguments;
  try {
    // PreToolUse 钩子:命令阻断则不执行该工具,把原因作为结果回灌。
    if (ctx.preToolHook) {
      const h = await ctx.preToolHook(name, argsJson);
      if (h.block) return { role: "tool", tool_call_id: tc.id, content: `[被 hook 阻止] ${h.reason || "(无原因)"}` };
    }
    const content = await registry.dispatch(name, argsJson, ctx);
    if (ctx.postToolHook) await ctx.postToolHook(name, argsJson, content); // PostToolUse(副作用,如自动格式化)
    return { role: "tool", tool_call_id: tc.id, content };
  } catch (err) {
    return { role: "tool", tool_call_id: tc.id, content: `Error: ${(err as Error).message}` };
  }
}

const rejectMsg = (tc: ToolCall, content: string): ToolMessage => ({
  role: "tool",
  tool_call_id: tc.id,
  content,
});

// 权限感知 + 并发安全地执行一批 tool_call:
// - 裁决:allow 待运行 / deny 直接拦截回灌 / ask 合并审批后定夺
// - 执行:安全工具(read/network/plan)成批并行(限 MAX_CONCURRENCY);write/exec 作屏障独占运行
// - 结果按原顺序返回
export async function executeToolCalls(
  toolCalls: ToolCall[],
  registry: ToolRegistry,
  ctx: ToolContext,
  gate: ApprovalGate,
): Promise<ToolMessage[]> {
  // 1. 逐次裁决:产出"待运行"集合与即时拒绝消息。
  const gatedRequests: ApprovalRequest[] = [];
  const results = new Map<string, ToolMessage>();
  const toRun = new Set<string>();
  for (const tc of toolCalls) {
    const tool = registry.get(tc.function.name);
    const decision = tool ? gate.decide(tc.function.name, tc.function.arguments, tool) : "allow";
    if (decision === "allow") toRun.add(tc.id);
    else if (decision === "deny") results.set(tc.id, rejectMsg(tc, "该操作被权限规则拒绝(deny)。如需放行,请在 .dao/settings.json 调整 permissions。"));
    else gatedRequests.push({ id: tc.id, toolName: tc.function.name, capability: tool!.capability, summary: `${tc.function.name} ${tc.function.arguments}`, argsJson: tc.function.arguments });
  }

  // 2. ask 工具合并审批
  const approvals =
    gatedRequests.length > 0 ? await gate.requestBatch(gatedRequests) : new Map<string, boolean>();
  for (const r of gatedRequests) {
    const tc = toolCalls.find((t) => t.id === r.id)!;
    if (approvals.get(tc.id)) toRun.add(tc.id);
    else results.set(tc.id, rejectMsg(tc, "用户拒绝执行该工具。"));
  }

  // 3. 按 capability 并发安全执行:安全工具积成一批并行(限并发);遇到 write/exec 先 flush 再独占运行(屏障)。
  const isSafe = (tc: ToolCall) => {
    const cap = registry.get(tc.function.name)?.capability;
    return cap !== undefined && SAFE_CAPS.has(cap);
  };
  let batch: ToolCall[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const group = batch;
    batch = [];
    let i = 0;
    const worker = async () => {
      while (i < group.length) {
        const tc = group[i++]!;
        results.set(tc.id, await dispatchOne(tc, registry, ctx));
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, group.length) }, worker));
  };
  for (const tc of toolCalls) {
    if (!toRun.has(tc.id)) continue; // deny / 被拒的已有结果
    if (isSafe(tc)) batch.push(tc);
    else {
      await flush(); // 屏障:先跑完已积累的安全批
      results.set(tc.id, await dispatchOne(tc, registry, ctx)); // 独占运行 write/exec
    }
  }
  await flush();

  // 4. 按原顺序收集
  return toolCalls.map((tc) => results.get(tc.id)!);
}
