// src/agent/resume_agent.ts
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChatMessage } from "../client/types.js";
import { ONE_SHOT_AGENT_TYPES } from "./agent_tools.js";
import type { AgentDef } from "./agent_defs.js";

/** 逐条写入 sidechain 转录(fire-and-forget) */
export async function recordSidechainMessage(subagentsDir: string, agentId: string, message: ChatMessage): Promise<void> {
  try {
    await fs.mkdir(subagentsDir, { recursive: true });
    await fs.appendFile(path.join(subagentsDir, `${agentId}.jsonl`), JSON.stringify(message) + "\n", "utf8");
  } catch { /* fire-and-forget */ }
}

/** 写入 agent 元数据 */
export async function writeAgentMetadata(subagentsDir: string, agentId: string, meta: { agentType: string; description?: string; worktreePath?: string; model?: string }): Promise<void> {
  try {
    await fs.mkdir(subagentsDir, { recursive: true });
    await fs.writeFile(path.join(subagentsDir, `${agentId}.meta.json`), JSON.stringify(meta, null, 2), "utf8");
  } catch { /* fire-and-forget */ }
}

/** 读取转录 */
export async function getAgentTranscript(subagentsDir: string, agentId: string): Promise<{ messages: ChatMessage[] } | null> {
  try {
    const raw = await fs.readFile(path.join(subagentsDir, `${agentId}.jsonl`), "utf8");
    const messages: ChatMessage[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim()) try { messages.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return { messages };
  } catch { return null; }
}

/** 读取元数据 */
export async function readAgentMetadata(subagentsDir: string, agentId: string): Promise<{ agentType: string; description?: string; worktreePath?: string; model?: string } | null> {
  try { return JSON.parse(await fs.readFile(path.join(subagentsDir, `${agentId}.meta.json`), "utf8")); }
  catch { return null; }
}

/** 过滤未配对 tool_use 的 assistant 消息 */
export function filterIncompleteToolCalls(messages: ChatMessage[]): ChatMessage[] {
  const idsWithResults = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id) idsWithResults.add(m.tool_call_id);
  }
  return messages.filter((m) => {
    if (m.role === "assistant" && m.tool_calls) {
      return !m.tool_calls.some((tc) => !idsWithResults.has(tc.id));
    }
    return true;
  });
}

/** 恢复已结束的子代理(对标 CC resumeAgentBackground) */
export async function resumeAgentBackground(opts: {
  agentId: string;
  prompt: string;
  subagentsDir: string;
  agentDefs: AgentDef[];
  runAgent: (params: unknown) => AsyncGenerator<ChatMessage, void>;
  registerAsyncAgent: (opts: { agentId: string; description: string }) => { agentId: string; abortController: AbortController };
  runAsyncAgentLifecycle: (opts: unknown) => Promise<void>;
}): Promise<{ agentId: string; description: string; outputFile: string }> {
  const { agentId, prompt, subagentsDir, agentDefs } = opts;
  const [transcript, meta] = await Promise.all([getAgentTranscript(subagentsDir, agentId), readAgentMetadata(subagentsDir, agentId)]);
  if (!transcript) throw new Error(`未找到子代理转录:${agentId}`);
  if (meta?.agentType && ONE_SHOT_AGENT_TYPES.has(meta.agentType)) {
    throw new Error(`${meta.agentType} 是一次性 agent,不支持恢复。`);
  }
  const resumedMessages = filterIncompleteToolCalls(transcript.messages);
  const { GENERAL_PURPOSE_AGENT } = await import("./bundled_agents.js");
  const agentDef = meta?.agentType ? (agentDefs.find((a) => a.agentType === meta.agentType) ?? GENERAL_PURPOSE_AGENT) : GENERAL_PURPOSE_AGENT;
  const promptMessages: ChatMessage[] = [...resumedMessages, { role: "user", content: prompt }];
  const description = meta?.description ?? "(恢复)";
  const bgTask = opts.registerAsyncAgent({ agentId, description });
  void opts.runAsyncAgentLifecycle({ taskId: bgTask.agentId, abortController: bgTask.abortController, makeStream: () => opts.runAgent({ agentDef, promptMessages, isAsync: true }), description, agentIdForCleanup: agentId });
  return { agentId, description, outputFile: path.join(subagentsDir, `${agentId}.jsonl`) };
}
