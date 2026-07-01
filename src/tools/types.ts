import type { ZodTypeAny, z } from "zod";
import type { Mode } from "./tools_for_mode.js";

export type Capability = "read" | "write" | "exec" | "network" | "plan";
export type Approval = "auto" | "suggest" | "required";

export interface ToolContext {
  // 工具的文件根目录;路径相对它解析。
  workspaceRoot: string;
  // 本会话已读文件的绝对路径集合(写工具据此判断"覆盖/编辑前是否已读");可选。
  readFiles?: Set<string>;
  // P2-23 读时元信息(mtime/size):写前复核,文件自上次读后被外部改动则拒绝(防覆盖并发改动)。
  readMeta?: Map<string, { mtime: number; size: number }>;
  // 向用户提问(ask_user 用);注入,便于测试。
  ask?: (question: string) => Promise<string>;
  // 结构化选择(ask_user 带 options 时用):单选 ↑↓/数字 选 + Enter;多选(multi)用 checkbox(空格/数字切换 + Enter 确认)。
  // 自动附"其他(自己输入)"与"先讨论一下"两项;返回选中项文本(多选逗号分隔)/自填内容/讨论标记。
  askChoice?: (question: string, options: string[], multi?: boolean) => Promise<string>;
  // 网络抓取(web_search/fetch_url 用);注入,默认全局 fetch。
  fetchImpl?: typeof fetch;
  // 一次性派发子代理,返回其最终结果(index 注入)。signal 透传以便父代理 abort 时停子代理。
  // agentType 指定自定义子代理类型(用其专属 prompt/工具白名单/模型);省略则用通用子代理。
  // workspaceRoot 覆盖子代理的工作区根(worktree 隔离用);省略则与父代理同根。
  // drainPending:后台子代理在回合边界消费 SendMessage 的来源。
  runSubagent?: (opts: {
    task: string;
    signal?: AbortSignal;
    agentType?: string;
    workspaceRoot?: string;
    drainPending?: () => string[];
    auditAgent?: "sub" | "bg"; // 缓存审计身份:后台传 "bg",前台/工具默认 "sub"
    model?: string;            // 调用级模型覆盖(后续任务起用);优先级最高
    mode?: Mode;               // 调用级权限模式覆盖(后续任务起用)
    messageParent?: (message: string) => void; // 后台子代理→父的 mid-run 出口(runBackgroundAgent 绑定)
  }) => Promise<string>;
  // ② fork 子代理:继承父代理已缓存的消息前缀(同 system/模型/工具),复用前缀缓存近乎免费;
  // 适合"带全量上下文做一个分支子任务"。任务作末尾指令,只此处与父对话不同。
  runForkAgent?: (task: string, signal?: AbortSignal, drainPending?: () => string[]) => Promise<string>;
  // 给运行中的后台子代理追加指令(SendMessage);返回是否送达(任务在跑)。
  sendToTask?: (id: string, message: string) => boolean;
  // (后台子代理用)给父代理发 mid-run 消息;由 runBackgroundAgent 绑定到本任务 id。前台子代理为 undefined。
  messageParent?: (message: string) => void;
  // 为隔离子代理创建 git worktree(改文件并行不冲突);非 git 仓库返回 null。
  createWorktree?: (id: string) => { root: string; branch: string; cleanup: () => void; hasChanges: () => boolean } | null;
  // 后台派发子代理,立即返回 task id;完成后结果经通知队列在后续回合注入(主循环不阻塞)。
  runBackgroundAgent?: (task: string, agentType?: string) => string;
  // 接管一个已在运行的子代理 promise 转入后台(前台超时自动后台化用)。
  adoptBackground?: (description: string, promise: Promise<string>) => string;
  // 可用的自定义子代理类型(名字+描述),供 agent 工具校验 agent_type。
  agentTypes?: { name: string; description: string }[];
  // 可用 skill(名字+描述+触发条件+slug+正文+目录),供 skill 工具按需加载正文。
  skills?: { name: string; description: string; whenToUse?: string; paths?: string[]; slug?: string; body: string; dir: string }[];
  // skill 工具加载某技能后回调:记录使用频率(用于发现/列表加权)。注入便于测试。
  recordSkillUse?: (name: string) => void;
  // skill_install 装完后:把新装技能加载进【当前会话】(追加式,便宜、无需重启)。返回新加载的技能名。
  // 交互/headless 都可(纯追加)。未注入(如子代理)=不支持,装完仍需重启生效。
  loadInstalledSkills?: (scope: "user" | "project") => Promise<string[]>;
  // 外来技能(为 CC/Codex/Gemini 等所写)正文 → DAO 适配:检测+按用途转换工具名(无字典,缓存)。
  // dao 原生技能原样返回。skill 工具加载正文时调用。注入便于测试。
  adaptSkill?: (body: string) => Promise<string>;
  // 子代理嵌套深度(防递归);主 agent 为 0/undefined,子代理内为 1。
  subagentDepth?: number;
  // 当前日期(ISO,YYYY-MM-DD);memory_write 据此记 created/lastUsed。注入便于测试。
  today?: string;
  // 用户主目录(用户级记忆 ~/.dao 的根);默认 os.homedir()。注入便于测试隔离真实主目录。
  homeDir?: string;
  // 中途取消信号(ESC/超时):工具据此提前终止(如 exec_shell 给子进程发 SIGTERM)。
  signal?: AbortSignal;
  // 可执行验收命令(DoD):设了则 verify_done 跑它判完成;未设则模型据证据自判。运行时可改。
  verifyCommand?: string;
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
  schema: ZodTypeAny;
  capability: Capability;
  approval: Approval;
  handler: (args: any, ctx: ToolContext) => Promise<string>;
  // 直接给 API 的参数 JSON Schema(MCP 工具用其原始 inputSchema);省略则由 schema(zod)转换。
  apiParameters?: object;
  // 工具自身的参数级权限自检(对标 CC tool.checkPermissions):仅能【收紧】——返回 "deny"/"ask"
  // 覆盖更宽的判定(如 exec 检出 download-execute),返回 null = 不干预。规则引擎判 allow 后才咨询它。
  checkPermissions?: (argsJson: string) => "deny" | "ask" | null;
}

// 定义单个工具时用,保留 handler 参数的精确类型(z.infer<S>)。
export interface ToolDefinition<S extends ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  capability: Capability;
  approval: Approval;
  handler: (args: z.infer<S>, ctx: ToolContext) => Promise<string>;
  checkPermissions?: (argsJson: string) => "deny" | "ask" | null;
}

export function defineTool<S extends ZodTypeAny>(def: ToolDefinition<S>): Tool {
  // handler 的精确参数类型擦除为 any;运行时由 registry 先 schema.parse 再调用,保证安全。
  return def as unknown as Tool;
}

// 执行器只依赖「能按名字派发」这一能力,便于测试时注入桩。
export interface ToolDispatcher {
  dispatch(name: string, rawArgs: string, ctx: ToolContext): Promise<string>;
}
