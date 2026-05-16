import type { ToolCall, ToolMessage } from "../client/types.js";
import type { ToolContext, ToolDispatcher } from "./types.js";

// 并发执行一批 tool_call;单个失败被隔离成错误结果,不影响其他与整批。
export async function executeToolCalls(
  toolCalls: ToolCall[],
  dispatcher: ToolDispatcher,
  ctx: ToolContext,
): Promise<ToolMessage[]> {
  return Promise.all(
    toolCalls.map(async (tc): Promise<ToolMessage> => {
      try {
        const content = await dispatcher.dispatch(tc.function.name, tc.function.arguments, ctx);
        return { role: "tool", tool_call_id: tc.id, content };
      } catch (err) {
        return { role: "tool", tool_call_id: tc.id, content: `Error: ${(err as Error).message}` };
      }
    }),
  );
}
