import type { ZodTypeAny, z } from "zod";

export type Capability = "read" | "write" | "exec" | "network" | "plan";
export type Approval = "auto" | "suggest" | "required";

export interface ToolContext {
  // 工具的文件根目录;路径相对它解析。
  workspaceRoot: string;
  // 本会话已读文件的绝对路径集合(写工具据此判断"覆盖/编辑前是否已读");可选。
  readFiles?: Set<string>;
  // 向用户提问(ask_user 用);注入,便于测试。
  ask?: (question: string) => Promise<string>;
  // 网络抓取(web_search/fetch_url 用);注入,默认全局 fetch。
  fetchImpl?: typeof fetch;
  // 一次性派发子代理,返回其最终结果(index 注入)。
  runSubagent?: (task: string) => Promise<string>;
  // 子代理嵌套深度(防递归);主 agent 为 0/undefined,子代理内为 1。
  subagentDepth?: number;
  // 当前日期(ISO,YYYY-MM-DD);memory_write 据此记 created/lastUsed。注入便于测试。
  today?: string;
  // 中途取消信号(ESC/超时):工具据此提前终止(如 exec_shell 给子进程发 SIGTERM)。
  signal?: AbortSignal;
  // 可执行验收命令(DoD):设了则 verify_done 跑它判完成;未设则模型据证据自判。运行时可改。
  verifyCommand?: string;
}

// 注册表内统一存储的工具(handler 参数在派发时由 schema 校验后传入)。
export interface Tool {
  name: string;
  description: string;
  schema: ZodTypeAny;
  capability: Capability;
  approval: Approval;
  handler: (args: any, ctx: ToolContext) => Promise<string>;
}

// 定义单个工具时用,保留 handler 参数的精确类型(z.infer<S>)。
export interface ToolDefinition<S extends ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  capability: Capability;
  approval: Approval;
  handler: (args: z.infer<S>, ctx: ToolContext) => Promise<string>;
}

export function defineTool<S extends ZodTypeAny>(def: ToolDefinition<S>): Tool {
  // handler 的精确参数类型擦除为 any;运行时由 registry 先 schema.parse 再调用,保证安全。
  return def as unknown as Tool;
}

// 执行器只依赖「能按名字派发」这一能力,便于测试时注入桩。
export interface ToolDispatcher {
  dispatch(name: string, rawArgs: string, ctx: ToolContext): Promise<string>;
}
