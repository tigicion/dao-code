import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ChatMessage } from "../client/types.js";
import type { ToolContext, Tool } from "../tools/types.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Mode } from "../tools/tools_for_mode.js";
import type { PermissionMode } from "../permissions/settings.js";
import { PermissionGate } from "../permissions/gate.js";
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
  /** 父会话的完整项目指令(CLAUDE.md/DAO.md/gitStatus 等已组装好的 system prompt);
   *  agentDef.omitClaudeMd!==true 时拼进子代理 system prompt,省 token 的一次性 agent(explore/plan)不拼。 */
  projectInstructions?: string;
  /** 后台子代理给父发 mid-run 消息的出口(message_parent 工具用);前台子代理不传 */
  messageParent?: (message: string) => void;
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
  /** 全局 MCP 配置(供 agent 专属 mcpServers 引用名解析) */
  mcpConfig?: import("../mcp/mcp.js").McpConfig;
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

/**
 * 给消息数组包一层 push 通知:每次 push 后同步调用 notify()。
 * 用于查询循环感知 runTurn 往 sub.messages 塞了新消息——同进程同事件循环内的数组变化,
 * 没必要靠定时轮询感知,notify 在 push 内同步触发,不引入额外延迟。
 * 只重写这一个数组实例的 push(不影响 Array.prototype),其余数组行为(length/索引/展开)不变。
 */
function withPushNotifier(arr: ChatMessage[], notify: () => void): ChatMessage[] {
  const push = arr.push.bind(arr);
  arr.push = (...items: ChatMessage[]) => {
    const result = push(...items);
    notify();
    return result;
  };
  return arr;
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
    messageParent,
    projectInstructions,
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

  // 权限模式解析(对标 CC:agentDef.permissionMode ?? 'acceptEdits')。
  // agentDef.permissionMode 可为 Mode(normal/plan)或 PermissionMode(default/acceptEdits/plan/auto/bypassPermissions)。
  // - plan:只读模式(Session.mode=plan + gate mode=plan,write/exec 被 deny)
  // - acceptEdits/default/auto/bypassPermissions:Session.mode=normal,gate 用该 PermissionMode
  // - normal/undefined:继承父级(Session.mode=normal,gate 用父级 mode)
  const rawPermMode = modeOverride ?? agentDef.permissionMode;
  const agentMode: Mode = rawPermMode === "plan" ? "plan" : "normal";

  // 子代理权限门:用子代理自己的 mode 裁决,而非继承父级 session 的 mode。
  // 对标 CC runAgent 的 agentGetAppState():把 toolPermissionContext.mode 替换为 agentDef.permissionMode。
  // 此前 dao 子代理和父级共用同一个 gate 对象,gate.getMode() 返回父级 session 的 mode,
  // 导致子代理的 permissionMode 设了也没用--explore(plan 模式)在父级 default 模式下仍按 default 裁决。
  const parentGate = gate as unknown as PermissionGate | undefined;
  let agentGate = gate;
  if (parentGate instanceof PermissionGate) {
    const parentMode = (gate as unknown as { getMode: () => PermissionMode }).getMode();
    // 解析子代理的 PermissionMode:
    // - plan -> "plan"
    // - acceptEdits/default/auto/bypassPermissions -> 直接用
    // - normal/undefined -> 继承父级(父 acceptEdits 子也 acceptEdits)
    const agentPermMode: PermissionMode =
      rawPermMode === "plan" ? "plan"
      : rawPermMode === "normal" || rawPermMode === undefined ? parentMode
      : rawPermMode;
    agentGate = parentGate.withModeOverride(agentPermMode);
  }

  // abort 控制器:不论同步/异步都真实创建——task_stop/cancel 要能对任何子代理生效,
  // 不能等它被标记 isAsync 才有 controller 可中止(前台子代理转后台前也可能被取消)。
  // - 调用方已传(前台路径由 agent.ts 的 registerAgentForeground 发,自己管链父信号的时机;
  //   异步路径是 taskManager.registerAsyncAgent 发的独立 controller)-> 直接用,这里不再重复链——
  //   调用方对"什么时候该断开父信号"(比如转后台那一刻)有自己的判断,这里瞎链一道反而定不下来
  //   什么时候该解绑。
  // - 调用方没传(isolate/fork/兜底等没有自己管理生命周期的路径):这里兜底新建 + 自动链父信号
  //   (保留"父 ESC 连带杀子"),并在 finally 里摘掉监听器,避免同一个父 signal 上永久堆监听器。
  const agentAbortController = override?.abortController ?? new AbortController();
  let detachParentAbort: (() => void) | undefined;
  if (!override?.abortController && !isAsync && toolUseContext.signal) {
    const parentSignal = toolUseContext.signal;
    if (parentSignal.aborted) {
      agentAbortController.abort();
    } else {
      const onParentAbort = () => agentAbortController.abort();
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
      detachParentAbort = () => parentSignal.removeEventListener("abort", onParentAbort);
    }
  }

  // ---- 阶段 2:上下文构建 ----

  // fork 路径:过滤未配对 tool_use,然后拼接(forkContextMessages 本身已含父的 system 消息)
  const contextMessages: ChatMessage[] = forkContextMessages
    ? filterIncompleteToolCalls(forkContextMessages)
    : [];

  // system prompt:override(fork 用父的)> 内置 agent 闭包 > 自定义 agent frontmatter content。
  // 除非 agentDef.omitClaudeMd(explore/plan 省 token),否则拼上父级 projectInstructions——
  // 不拼的话子代理完全拿不到 CLAUDE.md/DAO.md/gitStatus 等项目上下文,只剩自己的角色 prompt。
  let agentSystemPrompt: string;
  if (override?.systemPrompt) {
    agentSystemPrompt = override.systemPrompt;
  } else {
    const own = agentDef.source === "built-in" ? agentDef.getSystemPrompt({ toolUseContext }) : agentDef.getSystemPrompt();
    agentSystemPrompt = agentDef.omitClaudeMd || !projectInstructions
      ? own
      : `${projectInstructions}\n\n# 你的专用角色(${agentDef.agentType})\n${own}`;
  }

  // 环境信息追加(对标 CC enhanceSystemPromptWithEnvDetails):子代理需要知道 cwd/platform/工具列表,
  // 否则它不知道自己在哪个目录、用什么命令。fork 路径已有父的完整 prompt(含环境信息),不重复追加。
  if (!override?.systemPrompt) {
    const cwd = worktreePath ?? toolUseContext.workspaceRoot ?? process.cwd();
    const toolNames = resolvedTools.toApiTools().map((t) => t.function.name).sort().join(", ");
    agentSystemPrompt += `\n\n# 环境信息\n工作目录: ${cwd}\n平台: ${process.platform}\n可用工具: ${toolNames}`;
  }

  // criticalSystemReminder:追加到 system prompt 末尾(对标 CC criticalSystemReminder_EXPERIMENTAL)。
  // system prompt 是 session.messages[0],每轮发给 LLM 且不会被压缩裁剪--等价于 CC 的每轮注入,
  // 但无需每轮临时拼接(缓存安全:内容会话内固定)。
  if (agentDef.criticalSystemReminder) {
    agentSystemPrompt += `\n\n${agentDef.criticalSystemReminder}`;
  }

  // ---- 阶段 3:Agent 级资源初始化 ----
  // Skills:agentDef.skills 预加载指定 skill 正文作为 system 消息(对标 CC agent 预加载 skills)。
  // MCP:agentDef.mcpServers 连接专属 MCP server,工具注入子代理工具池,finally 清理。
  let agentMcpConnections: import("../mcp/mcp.js").McpConnections | undefined;
  if (agentDef.mcpServers && agentDef.mcpServers.length > 0 && params.mcpConfig) {
    const McpConfig = params.mcpConfig;
    // agent 的 mcpServers 是引用名(如 "github")或内联定义;从全局配置解析。
    const agentServerConfig: Record<string, import("../mcp/mcp.js").McpServerConfig> = {};
    for (const spec of agentDef.mcpServers) {
      if (typeof spec === "string") {
        // 引用名:从全局 MCP 配置查找
        const found = McpConfig.mcpServers?.[spec];
        if (found) agentServerConfig[spec] = found;
      } else {
        // 内联定义:{ name: { command, args, env } }
        for (const [name, cfg] of Object.entries(spec)) agentServerConfig[name] = cfg;
      }
    }
    if (Object.keys(agentServerConfig).length > 0) {
      try {
        const { connectMcpServers } = await import("../mcp/mcp.js");
        agentMcpConnections = await connectMcpServers({ mcpServers: agentServerConfig });
        for (const t of agentMcpConnections.tools) resolvedTools.register(t);
      } catch { /* MCP 连接失败不阻塞子代理启动 */ }
    }
  }

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
  // initialPrompt:作为首条 user 消息注入(对标 CC agent initialPrompt)。
  if (agentDef.initialPrompt) {
    initialMessages.push({ role: "user", content: agentDef.initialPrompt });
  }
  // skills 预加载:把指定 skill 正文作为 system 消息注入(对标 CC agent skills 预加载)。
  if (agentDef.skills && agentDef.skills.length > 0) {
    const allSkills = toolUseContext.skills ?? [];
    for (const skillName of agentDef.skills) {
      const skill = allSkills.find((s) => s.name === skillName || s.slug === skillName);
      if (skill) {
        initialMessages.push({ role: "system", content: `[预加载技能: ${skill.name}]
${skill.body}` });
      }
    }
  }
  if (startOutcome.additionalContext) {
    initialMessages.push({ role: "system", content: `[hook 注入的上下文]\n${startOutcome.additionalContext}` });
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
  // 替换默认 system message 为组装好的消息序列(已在上面保证包含 system 消息)。
  // 包一层 push 通知:runTurn 往 sub.messages push 新消息时同步唤醒下面的查询循环——
  // 同进程同事件循环内自己写的数组,没道理靠"每 200ms 醒来看一眼长度变没变"的轮询感知
  // 自己的变化,那样中间消息最多要攒够一个轮询周期才 yield 得出去,纯属浪费。
  let wakeQueryLoop: (() => void) | undefined;
  sub.messages = withPushNotifier([...initialMessages], () => wakeQueryLoop?.());

  // 缓存安全参数回调(后台摘要用)--必须在 sub 创建后触发,传 sub.messages 引用而非
  // initialMessages 静态快照:summarizer 持有引用后,runTurn 往 sub.messages push 的消息
  // 能被 summarizer 看到。此前传 initialMessages,摘要永远只有初始 system+user,tool_calls 恒为 0。
  if (onCacheSafeParams) {
    onCacheSafeParams({
      systemPrompt: agentSystemPrompt,
      forkContextMessages: sub.messages,
    });
  }

  // 子代理 ToolContext:独立 readFiles/readMeta(不污染父);worktreePath 存在时覆盖工作区根
  const subDepth = (toolUseContext.subagentDepth ?? 0) + 1;
  const subCtx: ToolContext = {
    ...toolUseContext,
    subagentDepth: subDepth,
    readFiles: new Set<string>(),
    readMeta: new Map<string, { mtime: number; size: number }>(),
    sessionModel: resolvedModel,
    ...(worktreePath ? { workspaceRoot: worktreePath } : {}),
    ...(messageParent ? { messageParent } : {}),
    signal: agentAbortController.signal,
  };

  // ---- 阶段 5:查询循环(边跑边 yield,不等 runTurn 整个跑完) ----

  const tracker = createProgressTracker();
  let yieldedCount = initialMessages.length;

  // yield sub.messages 中尚未 yield 的新消息
  const yieldNewMessages = function* (): Generator<ChatMessage> {
    while (yieldedCount < sub.messages.length) {
      const msg = sub.messages[yieldedCount]!;
      onQueryProgress?.();
      tracker.updateFromMessage(msg);
      void recordSidechainMessage(subagentsDir, agentId, msg).catch(() => {});
      yieldedCount++;
      yield msg;
    }
  };

  try {
    if (runTurn && config && streamChat && executeToolCalls && gate) {
      // 子代理输出攒 buffer(防并发子代理 write 交织)
      const buf: string[] = [];
      let runTurnError: unknown;
      const resolvedGate = agentGate!; // agentGate !== undefined:gate 已在 if 条件中检查,agentGate 要么是 gate 要么是 withModeOverride 的产物

      // runTurn 在后台跑,往 sub.messages push 消息;push 时 withPushNotifier 同步唤醒下面的查询循环
      const runTurnPromise = (async () => {
        await runTurn({
          session: sub,
          config,
          registry: resolvedTools,
          ctx: subCtx,
          gate: resolvedGate,
          streamChat,
          executeToolCalls,
          write: (s) => buf.push(s),
          signal: agentAbortController.signal,
          drainPending,
          background: true, // 子代理:遇 529 不重试/不回退
          selfChallenge: true, // 子代理跑确定性卡住检测
          maxTurns: maxTurnsOverride ?? agentDef.maxTurns ?? 200,
          ...(agentDef.effort ? { reasoningEffort: agentDef.effort } : {}),
          ...(auditSink ? { auditSink, auditId: { agent: "sub" as const, subId: agentId, depth: subDepth } } : {}),
        });
      })();

      // 事件驱动:每轮先把已产出的消息 yield 完,再"睡到下一次 push 或 runTurn 结束"为止——
      // 不设固定周期轮询,wake 由 push 同步触发,runTurnPromise 由 runTurn 结束触发,谁先到算谁。
      while (true) {
        yield* yieldNewMessages();
        const settled = await Promise.race([
          runTurnPromise.then(() => true).catch((e) => { runTurnError = e; return true; }),
          new Promise<boolean>((resolve) => { wakeQueryLoop = () => resolve(false); }),
        ]);
        wakeQueryLoop = undefined;
        if (settled) break;
      }

      // flush runTurn 可能在最后一次 wake 之后又 push 的消息(resolve 和 yield 之间的竞态)
      yield* yieldNewMessages();

      // flush 子代理输出
      if (buf.length) write(buf.join(""));

      if (runTurnError) throw runTurnError;
    } else {
      // 无 runTurn(测试环境):没有消息要 yield
    }

    // 转录落盘
    try { writeTranscript?.(sub.messages); } catch { /* 落盘失败不影响结果 */ }

    // ---- 阶段 6:回调 ----
    // 内置 agent 的 callback(如有)-- Phase 1 无内置 agent 有 callback

  } finally {
    // ---- 阶段 7:清理 ----
    // - 摘掉兜底链的父 abort 监听器(若有):不摘的话,同一个父 signal 被反复派发的
    //   isolate/fork/兜底子代理每次都挂一个 {once:true} 监听器,正常跑完的那些永远不触发、
    //   永远不会自动摘,长会话攒下去就是无界的监听器 + 闭包泄漏。
    detachParentAbort?.();
    // - Hooks 注销 + 执行 SubagentStop(会话已结束,不再收集 additionalContext)
    await executeSubagentStopHooks(agentId, agentDef.agentType, hookRegistry, worktreePath ?? toolUseContext.workspaceRoot).catch(() => {});
    clearAgentHooks(agentId, hookRegistry);
    // - MCP 连接清理:agent 专属 MCP server(阶段3 连接的)
    if (agentMcpConnections) { try { await agentMcpConnections.close(); } catch { /* 已死 */ } }
    // - readFileState 释放(子代理独立 Set/Map,随 GC 回收)
    // - shell tasks / todos 清理(Phase 2,留待后续:子代理派生的后台 shell/TodoWrite 残留目前不清)
  }
}
