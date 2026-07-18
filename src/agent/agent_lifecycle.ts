// src/agent/agent_lifecycle.ts
// 驱动后台/异步子代理真正跑起来的生命周期函数(对标 CC runAsyncAgentLifecycle)。
// 计划文档只把它的类型/参数名写在 Task 10/13 里,从未实现函数体——这里补上。
import type { ChatMessage } from "../client/types.js";
import { finalizeAgentTool } from "./agent_tools.js";
import { startAgentSummarization } from "./agent_summary.js";
import { classifyHandoffIfNeeded } from "./agent_handoff.js";
import type { CacheSafeParams } from "./runAgent.js";

export interface AsyncAgentTaskManager {
  appendMessage: (taskId: string, message: ChatMessage) => boolean;
  updateSummary: (taskId: string, summary: string) => boolean;
  update: (taskId: string, patch: { status?: "completed" | "failed" | "canceled"; result?: string }) => boolean;
}

export interface RunAsyncAgentLifecycleOpts {
  taskId: string;
  agentId: string;
  agentType?: string;
  isBuiltInAgent?: boolean;
  prompt: string;
  model: string;
  startTime?: number;
  /** 生成消息流;收到的 onCacheSafeParams 在 runAgent 内部阶段 2 结束后触发一次,用于启动摘要 */
  makeStream: (onCacheSafeParams: (params: CacheSafeParams) => void) => AsyncGenerator<ChatMessage, void>;
  taskManager: AsyncAgentTaskManager;
  /** 可注入(测试用);默认走真实的 startAgentSummarization */
  startSummarization?: typeof startAgentSummarization;
  /** auto 模式 handoff 安全审查:子代理结束后审查转录 */
  classifyFn?: (transcript: string) => Promise<import("./agent_handoff.js").ClassifyResult>;
  /** 当前权限模式(classifyHandoffIfNeeded 用,仅 auto 触发) */
  permissionMode?: string;
  /** 子代理消息(供 handoff 审查用) */
  abortSignal?: AbortSignal;
}

export async function runAsyncAgentLifecycle(opts: RunAsyncAgentLifecycleOpts): Promise<void> {
  const startTime = opts.startTime ?? Date.now();
  const startSummarization = opts.startSummarization ?? startAgentSummarization;
  const messages: ChatMessage[] = [];
  let summaryHandle: { stop: () => void } | undefined;

  const finalize = () => finalizeAgentTool(messages, opts.agentId, {
    prompt: opts.prompt,
    model: opts.model,
    agentType: opts.agentType ?? "general-purpose",
    startTime,
    isAsync: true,
    isBuiltInAgent: opts.isBuiltInAgent ?? false,
  });

  try {
    const stream = opts.makeStream((params) => {
      summaryHandle = startSummarization(
        opts.taskId,
        opts.agentId,
        { systemPrompt: params.systemPrompt, messages: params.forkContextMessages, model: opts.model },
        (taskId, summary) => opts.taskManager.updateSummary(taskId, summary),
      );
    });

    for await (const msg of stream) {
      messages.push(msg);
      opts.taskManager.appendMessage(opts.taskId, msg);
    }

    const result = finalize();
    let text = result.content.map((c) => c.text).join("\n") || "(无输出)";
    // auto 模式 handoff 安全审查:子代理结束后审查整段转录
    if (opts.classifyFn && opts.permissionMode) {
      const warning = await classifyHandoffIfNeeded({
        agentMessages: [{ role: "user", content: opts.prompt }, ...messages],
        permissionMode: opts.permissionMode,
        abortSignal: opts.abortSignal ?? new AbortController().signal,
        subagentType: opts.agentType ?? "general-purpose",
        totalToolUseCount: result.totalToolUseCount,
        classifyFn: opts.classifyFn,
      });
      if (warning) text = `${warning}\n\n${text}`;
    }
    opts.taskManager.update(opts.taskId, { status: "completed", result: text });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    const partialText = finalize().content.map((c) => c.text).join("\n");
    opts.taskManager.update(opts.taskId, {
      status: "failed",
      result: partialText ? `${errMsg}\n\n(部分输出)\n${partialText}` : errMsg,
    });
  } finally {
    summaryHandle?.stop();
  }
}
