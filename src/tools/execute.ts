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

const rejectMsg = (tc: ToolCall, content: string): ToolMessage => ({
  role: "tool",
  tool_call_id: tc.id,
  content,
});

// 权限感知地执行一批 tool_call(CC 风格逐次裁决):
// - allow / 未知工具:立即并发派发
// - deny:被权限规则拦截,不执行,回灌拦截消息
// - ask:合并成一次提示,批准的并发派发、被拒返回拒绝消息
// - 结果按原顺序返回
export async function executeToolCalls(
  toolCalls: ToolCall[],
  registry: ToolRegistry,
  ctx: ToolContext,
  gate: ApprovalGate,
): Promise<ToolMessage[]> {
  // 1. 逐次裁决
  const gatedRequests: ApprovalRequest[] = [];
  const started = new Map<string, Promise<ToolMessage>>();
  for (const tc of toolCalls) {
    const tool = registry.get(tc.function.name);
    const decision = tool ? gate.decide(tc.function.name, tc.function.arguments, tool) : "allow";
    if (decision === "allow") {
      started.set(tc.id, dispatchOne(tc, registry, ctx)); // 立即并发启动
    } else if (decision === "deny") {
      started.set(tc.id, Promise.resolve(rejectMsg(tc, "该操作被权限规则拒绝(deny)。如需放行,请在 .dao/settings.json 调整 permissions。")));
    } else {
      gatedRequests.push({
        id: tc.id,
        toolName: tc.function.name,
        capability: tool!.capability,
        summary: `${tc.function.name} ${tc.function.arguments}`,
        argsJson: tc.function.arguments,
      });
    }
  }

  // 2. 合并请求 ask 工具的审批
  const approvals =
    gatedRequests.length > 0 ? await gate.requestBatch(gatedRequests) : new Map<string, boolean>();

  // 3. 批准的并发派发,被拒返回拒绝消息
  for (const r of gatedRequests) {
    const tc = toolCalls.find((t) => t.id === r.id)!;
    started.set(
      tc.id,
      approvals.get(tc.id) ? dispatchOne(tc, registry, ctx) : Promise.resolve(rejectMsg(tc, "用户拒绝执行该工具。")),
    );
  }

  // 4. 按原顺序收集
  return Promise.all(toolCalls.map((tc) => started.get(tc.id)!));
}
