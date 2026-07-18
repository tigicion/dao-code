import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChatMessage, AssistantMessage } from "../client/types.js";
import type { ToolContext } from "../tools/types.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Mode } from "../tools/tools_for_mode.js";
import { Session } from "../session/session.js";
import type { TurnDeps } from "./loop.js";
import type { AgentDef } from "./agent_defs.js";
import { resolveAgentTools, createProgressTracker } from "./agent_tools.js";

// ---- 类型 ----

/** runAgent 的参数(对标 CC runAgent 的参数对象) */
export interface RunAgentParams {
  /** agent 定义(含 system prompt / 工具 / 模型 / 权限) */
  agentDef: AgentDef;
  /** 初始消息(用户 task) */
  promptMessages: ChatMessage[];
  /** 父代理的 ToolContext */
  toolUseContext: ToolContext;
  /** 权限检查函数(透传给 runTurn) */
  canUseTool?: unknown;
  /** 是否异步(后台运行) */
  isAsync: boolean;
  /** fork 路径:父的完整对话历史 */
  forkContextMessages?: ChatMessage[];
  /** 覆盖项 */
  override?: {
    systemPrompt?: string;
    abortController?: AbortController;
    agentId?: string;
  };
  /** 调用级模型覆盖(优先级最高) */
  model?: string;
  /** 回合上限覆盖 */
  maxTurns?: number;
  /** 预组装工具池 */
  availableTools?: ToolRegistry;
  /** fork 路径:直接用父的工具池(缓存对齐) */
  useExactTools?: boolean;
  /** worktree 隔离路径 */
  worktreePath?: string;
  /** 任务描述(持久化用) */
  description?: string;
  /** 缓存安全参数回调(后台摘要用) */
  onCacheSafeParams?: (params: CacheSafeParams) => void;
  /** 每条消息回调(活性检测用) */
  onQueryProgress?: () => void;
  // 以下由 index.ts 装配注入(非外部调用者提供)
  /** API 配置 */
  config?: { baseUrl: string; apiKey: string };
  /** 流式聊天函数 */
  streamChat?: TurnDeps["streamChat"];
  /** 工具调用执行器 */
  executeToolCalls?: TurnDeps["executeToolCalls"];
  /** 审批门 */
  gate?: TurnDeps["gate"];
  /** runTurn 函数 */
  runTurn?: (deps: TurnDeps) => Promise<void>;
  /** 输出函数 */
  write?: (s: string) => void;
  /** 转录写入回调 */
  writeTranscript?: (messages: ChatMessage[]) => void;
  /** 回合边界消费追加消息(SendMessage) */
  drainPending?: () => string[];
  /** 缓存审计 sink */
  auditSink?: TurnDeps["auditSink"];
}

/** 缓存安全参数(后台摘要 fork 用) */
export interface CacheSafeParams {
  systemPrompt: string;
  forkContextMessages: ChatMessage[];
}

// ---- 模型解析 ----

/**
 * 解析 agent 模型(对标 CC getAgentModel)。
 * 优先级:调用级 model > agent 定义 model > inherit(父模型)
 */
export function getAgentModel(
  agentModel: string | undefined,
  parentModel: string,
  overrideModel: string | undefined,
): string {
  // 调用级覆盖优先
  if (overrideModel) return overrideModel;
  // agent 定义指定了模型(且不是 inherit)
  if (agentModel && agentModel !== "inherit") return agentModel;
  // 默认继承父模型
  return parentModel;
}

// ---- 消息过滤 ----

/**
 * 过滤未配对 tool_use 的 assistant 消息(对标 CC filterIncompleteToolCalls)。
 * 防止 fork 上下文中有孤儿 tool_call 导致 API 报错。
 */
export function filterIncompleteToolCalls(messages: ChatMessage[]): ChatMessage[] {
  // 收集所有有 tool result 的 tool_call_id
  const toolUseIdsWithResults = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool") {
      toolUseIdsWithResults.add(m.tool_call_id);
    }
  }

  return messages.filter((m) => {
    if (m.role !== "assistant") return true;
    const a = m as AssistantMessage;
    if (!a.tool_calls || a.tool_calls.length === 0) return true;
    // 如果有任何一个 tool_call 没有对应 result,过滤掉这条 assistant
    const hasIncomplete = a.tool_calls.some((tc) => !toolUseIdsWithResults.has(tc.id));
    return !hasIncomplete;
  });
}

// ---- 子代理上下文 ----

/** 子代理的 sidechain 转录目录 */
function getSubagentDir(): string {
  return path.join(process.cwd(), ".dao", "subagents");
}

/** 生成 agent ID */
function createAgentId(): string {
  return `agent-${randomUUID().slice(0, 8)}`;
}

/**
 * 逐条写入 sidechain 转录(fire-and-forget,失败不影响运行)。
 * 对标 CC recordSidechainTranscript -- 每条消息追加一行 JSON。
 */
async function recordSidechainMessage(agentId: string, messages: ChatMessage[]): Promise<void> {
  const dir = getSubagentDir();
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  const file = path.join(dir, `${agentId}.jsonl`);
  const lines = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
  await fs.appendFile(file, lines, "utf8").catch(() => {});
}

/** 写入 agent 元数据(对标 CC writeAgentMetadata) */
async function writeAgentMetadata(
  agentId: string,
  meta: { agentType: string; description?: string; worktreePath?: string; model?: string },
): Promise<void> {
  const dir = getSubagentDir();
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  const file = path.join(dir, `${agentId}.meta.json`);
  await fs.writeFile(file, JSON.stringify(meta, null, 2), "utf8").catch(() => {});
}

// ---- 执行引擎 ----

/**
 * 子代理执行引擎(对标 CC runAgent)。
 * AsyncGenerator:逐条 yield ChatMessage,上层可消费消息流。
 *
 * 7 个阶段:
 * 1. 参数解析(模型/工具/权限)
 * 2. 上下文构建(system prompt + 消息组装)
 * 3. Agent 级资源初始化(hooks/skills/memory/mcp -- Phase 1 预留接口)
 * 4. 会话创建
 * 5. 查询循环(runTurn + yield)
 * 6. 回调(内置 agent callback)
 * 7. 清理(finally)
 */
export async function* runAgent(params: RunAgentParams): AsyncGenerator<ChatMessage, void> {
  const {
    agentDef,
    promptMessages,
    toolUseContext,
    isAsync,
    forkContextMessages,
    override,
    model: modelOverride,
    maxTurns: maxTurnsOverride,
    availableTools,
    useExactTools = false,
    worktreePath,
    description,
    onCacheSafeParams,
    onQueryProgress,
    config,
    streamChat,
    executeToolCalls,
    gate,
    runTurn,
    write = () => {},
    writeTranscript,
    drainPending,
    auditSink,
  } = params;

  // ---- 阶段 1:参数解析 ----

  const parentModel = toolUseContext.sessionModel ?? "deepseek-v4-pro";
  const resolvedModel = getAgentModel(agentDef.model, parentModel, modelOverride);
  const agentId = override?.agentId ?? createAgentId();

  // 工具解析:useExactTools 直接用父的工具池(fork 路径);否则走 resolveAgentTools
  let resolvedTools: ToolRegistry;
  if (useExactTools && availableTools) {
    resolvedTools = availableTools;
  } else {
    const pool = availableTools ?? new ToolRegistry();
    const result = resolveAgentTools(agentDef, pool, isAsync);
    resolvedTools = result.resolvedTools;
  }

  // 权限模式:agent 定义覆盖父的(除非父是 auto/bypass)
  let agentMode: Mode = "normal";
  if (agentDef.permissionMode) {
    agentMode = agentDef.permissionMode;
  }

  // abort 控制器:异步=独立(不随父 ESC 死);同步=共享父的
  const agentAbortController = override?.abortController
    ? override.abortController
    : isAsync
      ? new AbortController()
      : (undefined as unknown as AbortController); // 同步由 runTurn 的 signal 透传

  // ---- 阶段 2:上下文构建 ----

  // fork 路径:过滤未配对 tool_use,然后拼接
  const contextMessages: ChatMessage[] = forkContextMessages
    ? filterIncompleteToolCalls(forkContextMessages)
    : [];

  // system prompt:override(fork 用父的)> 内置 agent 闭包 > 自定义 agent frontmatter content
  let agentSystemPrompt: string;
  if (override?.systemPrompt) {
    agentSystemPrompt = override.systemPrompt;
  } else if (agentDef.source === "built-in") {
    agentSystemPrompt = agentDef.getSystemPrompt({ toolUseContext });
  } else {
    agentSystemPrompt = agentDef.getSystemPrompt();
  }

  // 初始消息:fork 上下文 + prompt
  const initialMessages: ChatMessage[] = [...contextMessages, ...promptMessages];

  // ---- 阶段 3:Agent 级资源初始化(Phase 1 预留接口) ----
  // Hooks:Phase 1 不实现(agent_hooks.ts 在 Task 7 实现,但此处预留调用点)
  // Skills:Phase 1 不实现(预加载 skill 作为 initial message)
  // Memory:Phase 1 不实现(agent_memory.ts 在 Task 6 实现,但此处预留调用点)
  // MCP:Phase 1 不实现(agent_mcp.ts 预留接口)

  // 缓存安全参数回调(后台摘要用)
  if (onCacheSafeParams) {
    onCacheSafeParams({
      systemPrompt: agentSystemPrompt,
      forkContextMessages: initialMessages,
    });
  }

  // 转录:写入初始消息 + 元数据(fire-and-forget)
  void recordSidechainMessage(agentId, initialMessages).catch(() => {});
  void writeAgentMetadata(agentId, {
    agentType: agentDef.agentType,
    ...(description && { description }),
    ...(worktreePath && { worktreePath }),
    model: resolvedModel,
  }).catch(() => {});

  // ---- 阶段 4:会话创建 ----

  const sub = new Session(agentSystemPrompt, resolvedModel);
  sub.mode = agentMode;
  // 替换默认 system message 为组装好的消息序列
  sub.messages = [...initialMessages];

  // 子代理 ToolContext:独立 readFiles/readMeta(不污染父)
  const subDepth = (toolUseContext.subagentDepth ?? 0) + 1;
  const subCtx: ToolContext = {
    ...toolUseContext,
    subagentDepth: subDepth,
    readFiles: new Set<string>(),
    readMeta: new Map<string, { mtime: number; size: number }>(),
    sessionModel: resolvedModel,
    // fork 路径保留父的 signal;异步路径用独立 controller
    ...(agentAbortController ? { signal: agentAbortController.signal } : {}),
  };

  // ---- 阶段 5:查询循环 ----

  const tracker = createProgressTracker();

  try {
    if (runTurn && config && streamChat && executeToolCalls && gate) {
      // 子代理输出攒 buffer(防并发子代理 write 交织)
      const buf: string[] = [];
      await runTurn({
        session: sub,
        config,
        registry: resolvedTools,
        ctx: subCtx,
        gate,
        streamChat,
        executeToolCalls,
        write: (s) => buf.push(s),
        signal: agentAbortController?.signal,
        drainPending,
        background: true, // 子代理:遇 529 不重试/不回退
        selfChallenge: true, // 子代理跑确定性卡住检测
        maxTurns: maxTurnsOverride ?? agentDef.maxTurns ?? 200,
        ...(auditSink ? { auditSink, auditId: { agent: "sub" as const, subId: agentId, depth: subDepth } } : {}),
      });

      // flush 子代理输出
      if (buf.length) write(buf.join(""));
    }

    // yield 生成的新消息(排除初始消息)
    for (let i = initialMessages.length; i < sub.messages.length; i++) {
      const msg = sub.messages[i]!;
      onQueryProgress?.();
      tracker.updateFromMessage(msg);
      // 逐条转录(fire-and-forget)
      void recordSidechainMessage(agentId, [msg]).catch(() => {});
      yield msg;
    }

    // 转录落盘
    try { writeTranscript?.(sub.messages); } catch { /* 落盘失败不影响结果 */ }

    // ---- 阶段 6:回调 ----
    // 内置 agent 的 callback(如有)-- Phase 1 无内置 agent 有 callback

  } finally {
    // ---- 阶段 7:清理 ----
    // Phase 1 清理:
    // - MCP 连接清理(agent_mcp.ts 实现)
    // - Hooks 注销(agent_hooks.ts 实现)
    // - readFileState 释放(子代理独立,随 GC)
    // - shell tasks 清理(Phase 2)
    // - todos 清理(Phase 2)
  }
}
