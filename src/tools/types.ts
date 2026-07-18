import type { ZodTypeAny, z } from "zod";
import type { Mode } from "./tools_for_mode.js";
import type { TaskManager } from "../agent/tasks.js";
import type { ClassifyResult } from "../agent/agent_handoff.js";
import type { LspManager } from "../lsp/manager.js";

export type Capability = "read" | "write" | "exec" | "network" | "plan";
export type Approval = "auto" | "suggest" | "required";

export interface ToolContext {
  // 项目身份根目录:memory/MCP/LSP/skills/settings/审计日志 等子系统都按它定位,启动时定一次,
  // 不随 worktree 切换而变——即使当前在某个 worktree 里干活,这些子系统仍指向"真正的项目"。
  workspaceRoot: string;
  // 路径解析根目录(文件读写/Bash/verify 等"在哪干活"用它);未设时回退到 workspaceRoot。
  // 只有 EnterWorktree/ExitWorktree 会改它——两者是分开的概念:workspaceRoot 回答"这是哪个项目",
  // cwd 回答"现在文件改动落在哪个目录"。别把两者混用,否则会出现"改的文件不在你以为的地方"这种 bug。
  cwd?: string;
  // 当前通过 EnterWorktree 进入的 worktree(未在 worktree 会话里则为空);ExitWorktree 靠它做
  // keep/remove 判断,并在退出时把 cwd 恢复到进入前的值。
  activeWorktree?: {
    root: string;
    branch: string;
    cleanup: () => void;
    hasChanges: () => boolean;
    previousCwd: string | undefined;
  };
  // 本会话已读文件的绝对路径集合(写工具据此判断"覆盖/编辑前是否已读");可选。
  readFiles?: Set<string>;
  // P2-23 读时元信息(mtime/size):写前复核,文件自上次读后被外部改动则拒绝(防覆盖并发改动)。
  readMeta?: Map<string, { mtime: number; size: number }>;
  // 向用户提问(AskUserQuestion 用);注入,便于测试。
  ask?: (question: string) => Promise<string>;
  // 结构化选择(AskUserQuestion 带 options 时用):单选 ↑↓/数字 选 + Enter;多选(multi)用 checkbox(空格/数字切换 + Enter 确认)。
  // 自动附"其他(自己输入)"与"先讨论一下"两项;返回选中项文本(多选逗号分隔)/自填内容/讨论标记。
  askChoice?: (question: string, options: string[], multi?: boolean) => Promise<string>;
  // 网络抓取(WebSearch/WebFetch 用);注入,默认全局 fetch。
  fetchImpl?: typeof fetch;
  // ---- 子代理系统(新:runAgent 统一接口) ----
  // 子代理派发(返回 AsyncGenerator,逐条 yield 消息)
  runAgent?: (params: {
    agentDef: import("../agent/agent_defs.js").AgentDef;
    promptMessages: import("../client/types.js").ChatMessage[];
    isAsync: boolean;
    override?: {
      systemPrompt?: string;
      abortController?: AbortController;
      agentId?: string;
    };
    model?: string;
    mode?: Mode;
    forkContextMessages?: import("../client/types.js").ChatMessage[];
    useExactTools?: boolean;
    worktreePath?: string;
    description?: string;
    onCacheSafeParams?: (params: { systemPrompt: string; forkContextMessages: import("../client/types.js").ChatMessage[] }) => void;
    messageParent?: (message: string) => void;
  }) => AsyncGenerator<import("../client/types.js").ChatMessage, void>;
  // Agent 恢复
  resumeAgent?: (agentId: string, prompt: string) => Promise<string>;
  // 可用 agent 定义(替代旧 agentTypes)
  agentDefinitions?: import("../agent/agent_defs.js").AgentDef[];
  // fork 时父消息
  forkMessages?: import("../client/types.js").ChatMessage[];
  // 给运行中的后台子代理追加指令(SendMessage);返回是否送达(任务在跑)。
  sendToTask?: (id: string, message: string) => boolean;
  // (后台子代理用)给父代理发 mid-run 消息;由 runAgent 的 messageParent 参数绑定到本任务 id。前台子代理为 undefined。
  messageParent?: (message: string) => void;
  // 直达人类桌面的即时通知(NotifyUser 用);与 messageParent 不同——不经任何代理层排队,当下就弹。
  notifyUser?: (message: string) => void;
  // 按关键词搜 MCP 工具并激活命中项(ToolSearch 用);激活后从下一次工具调用起才会出现在发给模型的
  // 工具列表里——MCP 工具默认不发,避免连了很多 server 时内置工具集合以外的部分拖累前缀缓存。
  searchTools?: (query: string) => string;
  // lsp 工具用:按文件类型路由到对应 language server(懒启动/复用),未配置对应类型时返回 error。
  lsp?: LspManager;
  // 为隔离子代理创建 git worktree(改文件并行不冲突);非 git 仓库返回 null。
  createWorktree?: (id: string) => { root: string; branch: string; cleanup: () => void; hasChanges: () => boolean } | null;
  // 完整任务管理器引用(TaskCreate/get/list/update/stop 用):同一个实例贯穿 launch/adopt/create/registerAsyncAgent/
  // registerAgentForeground,不是并行的第二套系统——agent 工具的后台/前台切换也走它。
  taskManager?: TaskManager;
  // auto 模式下子代理结束后审查整段转录的分类器(对标 CC classifyHandoffIfNeeded)。
  // 传入紧凑 transcript(JSONL),返回 {shouldBlock, reason} 或 {unavailable}。非 auto 模式下不会被调用。
  handoffClassifyFn?: (transcript: string) => Promise<ClassifyResult>;
  // 当前权限模式(auto/default/acceptEdits/plan/bypassPermissions);handoff 审查只在 auto 模式触发
  permissionMode?: string;
  // 可用 skill(名字+描述+触发条件+slug+正文+目录),供 skill 工具按需加载正文。
  skills?: { name: string; description: string; whenToUse?: string; paths?: string[]; slug?: string; body: string; dir: string }[];
  // skill 工具加载某技能后回调:记录使用频率(用于发现/列表加权)。注入便于测试。
  recordSkillUse?: (name: string) => void;
  // SkillInstall 装完后:把新装技能加载进【当前会话】(追加式,便宜、无需重启)。返回新加载的技能名。
  // 交互/headless 都可(纯追加)。未注入(如子代理)=不支持,装完仍需重启生效。
  loadInstalledSkills?: (scope: "user" | "project") => Promise<string[]>;
  // 外来技能(为 CC/Codex/Gemini 等所写)正文 → DAO 适配:检测+按用途转换工具名(无字典,缓存)。
  // dao 原生技能原样返回。skill 工具加载正文时调用。注入便于测试。
  adaptSkill?: (body: string) => Promise<string>;
  // 子代理嵌套深度(防递归);主 agent 为 0/undefined,子代理内为 1。
  subagentDepth?: number;
  // 当前会话模型名(Read 读图片时检查是否支持多模态)。
  sessionModel?: string;
  // 切换会话模式(plan/normal);plan_mode 工具用。省略则不支持模式切换(子代理等场景)。
  setMode?: (mode: "normal" | "plan") => void;
  // 暂存工具返回的图片数据,由 execute.ts 在构建 ToolMessage 时读取并清空。
  currentImageData?: { base64: string; mediaType: string };
  // 当前日期(ISO,YYYY-MM-DD);MemoryWrite 据此记 created/lastUsed。注入便于测试。
  today?: string;
  // 用户主目录(用户级记忆 ~/.dao 的根);默认 os.homedir()。注入便于测试隔离真实主目录。
  homeDir?: string;
  // 中途取消信号(ESC/超时):工具据此提前终止(如 Bash 给子进程发 SIGTERM)。
  signal?: AbortSignal;
  // 申请访问工作区外路径(读类工具用):返回是否获批。未注入(非交互)默认拒绝。
  // 一次授权后同会话/本仓库后续外部读不再追问(减少阻塞)。
  approveExternalRead?: (absPath: string) => Promise<boolean>;
  approveExternalWrite?: (absPath: string) => Promise<boolean>;
  // 生命周期钩子(hooks):工具执行前/后触发用户配置的命令。pre 返回 block 则拦截该工具。
  // permissionDecision:hook 对权限的"最后一公里"裁决(deny 拦截 / ask 强制审批 / allow 在非敏感时放行);
  // updatedInput:hook 改写后的工具入参(派发前替换);additionalContext:附到工具结果让模型看见。
  preToolHook?: (toolName: string, argsJson: string) => Promise<{
    block: boolean;
    reason: string;
    additionalContext?: string;
    permissionDecision?: "allow" | "ask" | "deny";
    updatedInput?: Record<string, unknown>;
  }>;
  postToolHook?: (toolName: string, argsJson: string, result: string) => Promise<void>;
  // 审计 sink(index 注入;无 store 路径为 NOOP)。
  toolAudit?: import("./tool_audit.js").ToolAuditSink;
  permAudit?: import("../permissions/perm_audit.js").PermAuditSink;
  memoryAudit?: import("../memory/memory_audit.js").MemoryAuditSink;
}

// 注册表内统一存储的工具(handler 参数在派发时由 schema 校验后传入)。
export interface Tool {
  name: string;
  description: string;
  descriptionEn?: string;
  // 动态描述生成(对标 CC AgentTool.prompt):存在时 toApiTools 优先用其返回值替代 description。
  // 用于 agent 工具:把 when-not-to-use / writing-prompt / 示例动态拼进描述,但 agent 列表留在
  // system prompt 层(保持工具 schema 静态,agent 列表变更不 bust 缓存)。
  prompt?: (ctx: { lang: "zh" | "en" }) => string;
  schema: ZodTypeAny;
  capability: Capability;
  approval: Approval;
  handler: (args: any, ctx: ToolContext) => Promise<string>;
  // 直接给 API 的参数 JSON Schema(MCP 工具用其原始 inputSchema);省略则由 schema(zod)转换。
  apiParameters?: object;
  // 工具自身的参数级权限自检(对标 CC tool.checkPermissions):仅能【收紧】——返回 "deny"/"ask"
  // 覆盖更宽的判定(如 exec 检出 download-execute),返回 null = 不干预。规则引擎判 allow 后才咨询它。
  checkPermissions?: (argsJson: string) => "deny" | "ask" | null;
  // 延迟加载(对标 CC shouldDefer):true 时初始只发 name+简短描述(不发完整 parameters),
  // 模型需用 ToolSearch 查询后才返回完整 schema 并激活。减少低频工具的 token 开销。
  shouldDefer?: boolean;
}

// 定义单个工具时用,保留 handler 参数的精确类型(z.infer<S>)。
export interface ToolDefinition<S extends ZodTypeAny> {
  name: string;
  description: string;
  descriptionEn?: string;
  prompt?: (ctx: { lang: "zh" | "en" }) => string;
  schema: S;
  capability: Capability;
  approval: Approval;
  handler: (args: z.infer<S>, ctx: ToolContext) => Promise<string>;
  checkPermissions?: (argsJson: string) => "deny" | "ask" | null;
  shouldDefer?: boolean;
}

export function defineTool<S extends ZodTypeAny>(def: ToolDefinition<S>): Tool {
  // handler 的精确参数类型擦除为 any;运行时由 registry 先 schema.parse 再调用,保证安全。
  return def as unknown as Tool;
}

// 执行器只依赖「能按名字派发」这一能力,便于测试时注入桩。
export interface ToolDispatcher {
  dispatch(name: string, rawArgs: string, ctx: ToolContext): Promise<string>;
}
