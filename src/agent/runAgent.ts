import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ChatMessage } from "../client/types.js";
import type { ToolContext, Tool } from "../tools/types.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Mode } from "../tools/tools_for_mode.js";
import { Session } from "../session/session.js";
import type { TurnDeps } from "./loop.js";
import type { AgentDef } from "./agent_defs.js";
import { resolveAgentTools, createProgressTracker } from "./agent_tools.js";
import { recordSidechainMessage, writeAgentMetadata, filterIncompleteToolCalls } from "./resume_agent.js";
import { registerAgentHooks, clearAgentHooks, executeSubagentStartHooks, executeSubagentStopHooks, type AgentHookRegistry } from "./agent_hooks.js";
import { loadAgentMemoryPrompt } from "./agent_memory.js";

export { filterIncompleteToolCalls };

// 记忆 agent 强制找回的工具(即使 tools/disallowedTools 把它们排除了)——没有读写能力,记忆等于白设。
const FORCED_MEMORY_TOOLS = ["read_file", "write_file", "edit_file"];

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
  /** 调用级权限模式覆盖(优先级:调用级 > agentDef.permissionMode > normal) */
  mode?: Mode;
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
  /** sidechain 转录目录(未传时兜底用 process.cwd()/.dao/subagents) */
  subagentsDir?: string;
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

// ---- 子代理上下文 ----
// 消息过滤(filterIncompleteToolCalls)、转录持久化(recordSidechainMessage/writeAgentMetadata)
// 与 resume_agent.ts 共用同一份实现(此前两处各写一份,写读目录拼法还不一致,resume 时会
// 读不到 runAgent 刚写的转录)——canonical 实现在 resume_agent.ts,这里只导入复用。

/** 默认 sidechain 转录目录(未显式传 subagentsDir 时的兜底) */
function defaultSubagentDir(): string {
  return path.join(process.cwd(), ".dao", "subagents");
}

/** 生成 agent ID */
function createAgentId(): string {
  return `agent-${randomUUID().slice(0, 8)}`;
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
    mode: modeOverride,
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

  // 权限模式:调用级 > agentDef.permissionMode > normal
  const agentMode: Mode = modeOverride ?? agentDef.permissionMode ?? "normal";

  // abort 控制器:异步=独立(不随父 ESC 死);同步=共享父的
  const agentAbortController = override?.abortController
    ? override.abortController
    : isAsync
      ? new AbortController()
      : (undefined as unknown as AbortController); // 同步由 runTurn 的 signal 透传

  // ---- 阶段 2:上下文构建 ----

  // fork 路径:过滤未配对 tool_use,然后拼接(forkContextMessages 本身已含父的 system 消息)
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

  // ---- 阶段 3:Agent 级资源初始化 ----
  // Skills:Phase 1 不实现(预加载 skill 作为 initial message)
  // MCP:Phase 1 不实现(agent_mcp.ts 预留接口,计划文档里也没有任务真正创建它)

  // Memory:agentDef.memory 设置时追加记忆 prompt,并强制找回 read/write/edit(即使被 disallowedTools 排除)
  if (agentDef.memory) {
    agentSystemPrompt += `\n\n${loadAgentMemoryPrompt(agentDef.agentType, agentDef.memory)}`;
    const pool = availableTools ?? new ToolRegistry();
    for (const name of FORCED_MEMORY_TOOLS) {
      if (!resolvedTools.get(name)) {
        const tool = pool.get(name);
        if (tool) resolvedTools.register(tool);
      }
    }
  }

  // Hooks:注册 + 执行 SubagentStart,additionalContext 作为一条 system 消息注入
  const hookRegistry: AgentHookRegistry = new Map();
  if (agentDef.hooks) registerAgentHooks(agentId, agentDef.hooks, hookRegistry);
  const startOutcome = await executeSubagentStartHooks(agentId, agentDef.agentType, hookRegistry, worktreePath ?? toolUseContext.workspaceRoot);

  // 初始消息:非 fork 路径补上 system 消息(此前整体替换 sub.messages 时把 Session 构造函数塞的
  // system 消息丢了——loop.ts 按 session.messages[0] 取 system prompt,丢了等于子代理裸奔无提示词跑)。
  // fork 路径的 contextMessages 已经带着父的 system 消息,不能再叠加一条。
  const initialMessages: ChatMessage[] = forkContextMessages
    ? [...contextMessages, ...promptMessages]
    : [{ role: "system", content: agentSystemPrompt }, ...promptMessages];
  if (startOutcome.additionalContext) {
    initialMessages.push({ role: "system", content: `[hook 注入的上下文]\n${startOutcome.additionalContext}` });
  }

  // 缓存安全参数回调(后台摘要用)
  if (onCacheSafeParams) {
    onCacheSafeParams({
      systemPrompt: agentSystemPrompt,
      forkContextMessages: initialMessages,
    });
  }

  // 转录:写入初始消息 + 元数据(fire-and-forget)
  const subagentsDir = params.subagentsDir ?? defaultSubagentDir();
  for (const m of initialMessages) void recordSidechainMessage(subagentsDir, agentId, m).catch(() => {});
  void writeAgentMetadata(subagentsDir, agentId, {
    agentType: agentDef.agentType,
    ...(description && { description }),
    ...(worktreePath && { worktreePath }),
    model: resolvedModel,
  }).catch(() => {});

  // ---- 阶段 4:会话创建 ----

  const sub = new Session(agentSystemPrompt, resolvedModel);
  sub.mode = agentMode;
  // 替换默认 system message 为组装好的消息序列(已在上面保证包含 system 消息)
  sub.messages = [...initialMessages];

  // 子代理 ToolContext:独立 readFiles/readMeta(不污染父);worktreePath 存在时覆盖工作区根
  const subDepth = (toolUseContext.subagentDepth ?? 0) + 1;
  const subCtx: ToolContext = {
    ...toolUseContext,
    subagentDepth: subDepth,
    readFiles: new Set<string>(),
    readMeta: new Map<string, { mtime: number; size: number }>(),
    sessionModel: resolvedModel,
    ...(worktreePath ? { workspaceRoot: worktreePath } : {}),
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
      void recordSidechainMessage(subagentsDir, agentId, msg).catch(() => {});
      yield msg;
    }

    // 转录落盘
    try { writeTranscript?.(sub.messages); } catch { /* 落盘失败不影响结果 */ }

    // ---- 阶段 6:回调 ----
    // 内置 agent 的 callback(如有)-- Phase 1 无内置 agent 有 callback

  } finally {
    // ---- 阶段 7:清理 ----
    // - Hooks 注销 + 执行 SubagentStop(会话已结束,不再收集 additionalContext)
    await executeSubagentStopHooks(agentId, agentDef.agentType, hookRegistry, worktreePath ?? toolUseContext.workspaceRoot).catch(() => {});
    clearAgentHooks(agentId, hookRegistry);
    // - MCP 连接清理:agent_mcp.ts 预留接口,计划里没有任务创建它,暂不做
    // - readFileState 释放(子代理独立 Set/Map,随 GC 回收)
    // - shell tasks / todos 清理(Phase 2,留待后续:子代理派生的后台 shell/TodoWrite 残留目前不清)
  }
}
