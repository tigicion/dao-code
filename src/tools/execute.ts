import type { ToolCall, ToolMessage } from "../client/types.js";
import type { ToolContext } from "./types.js";
import type { ToolRegistry } from "./registry.js";
import type { ApprovalGate, ApprovalRequest } from "../approval/types.js";

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

// 审批感知地执行一批 tool_call:
// - auto / 未知工具立即并发派发(不被审批阻塞)
// - 需审批的工具合并成一次提示,批准的并发派发、被拒返回拒绝消息
// - 结果按原顺序返回
export async function executeToolCalls(
  toolCalls: ToolCall[],
  registry: ToolRegistry,
  ctx: ToolContext,
  gate: ApprovalGate,
): Promise<ToolMessage[]> {
  // 1. 分类
  const gatedRequests: ApprovalRequest[] = [];
  for (const tc of toolCalls) {
    const tool = registry.get(tc.function.name);
    if (tool && gate.needsApproval(tool)) {
      gatedRequests.push({
        id: tc.id,
        toolName: tc.function.name,
        capability: tool.capability,
        summary: `${tc.function.name} ${tc.function.arguments}`,
      });
    }
  }
  const gatedIds = new Set(gatedRequests.map((r) => r.id));

  // 2. auto 立即并发启动(在审批提示之前)
  const started = new Map<string, Promise<ToolMessage>>();
  for (const tc of toolCalls) {
    if (!gatedIds.has(tc.id)) started.set(tc.id, dispatchOne(tc, registry, ctx));
  }

  // 3. 合并请求 gated 工具的审批
  const approvals =
    gatedRequests.length > 0 ? await gate.requestBatch(gatedRequests) : new Map<string, boolean>();

  // 4. 批准的 gated 并发派发,被拒返回拒绝消息
  for (const tc of toolCalls) {
    if (!gatedIds.has(tc.id)) continue;
    if (approvals.get(tc.id)) {
      started.set(tc.id, dispatchOne(tc, registry, ctx));
    } else {
      started.set(
        tc.id,
        Promise.resolve<ToolMessage>({
          role: "tool",
          tool_call_id: tc.id,
          content: "用户拒绝执行该工具。",
        }),
      );
    }
  }

  // 5. 按原顺序收集
  return Promise.all(toolCalls.map((tc) => started.get(tc.id)!));
}
