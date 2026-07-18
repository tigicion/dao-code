// src/agent/fork_agent.ts
import type { ChatMessage, AssistantMessage, UserMessage, ContentPart } from "../client/types.js";
import type { BuiltInAgentDef } from "./agent_defs.js";

// fork-boilerplate XML 标签名:包裹 fork 子代理的规则 directive
export const FORK_BOILERPLATE_TAG = "fork-boilerplate";

// directive 文本前缀(渲染时剥离,仅标记 directive 起始)
export const FORK_DIRECTIVE_PREFIX = "你的指令: ";

/**
 * Fork agent 的合成定义(不注册到 BUNDLED_AGENTS)。
 * fork 路径由 `fork: true` 参数触发(参考 省略 subagent_type)。
 * - tools = undefined + useExactTools = 直接用父的工具池(缓存对齐)
 * - model = inherit(继承父模型,保持上下文长度一致)
 * - getSystemPrompt 返回空:实际用 override.systemPrompt 传父的 rendered prompt
 */
export const FORK_AGENT: BuiltInAgentDef = {
  agentType: "fork",
  whenToUse: "隐式 fork - 继承父代理完整上下文。不可通过 agent_type 指定;由 fork=true 触发。",
  tools: undefined,
  model: "inherit",
  source: "built-in",
  getSystemPrompt: () => "",
};

/**
 * 检测消息列表中是否已有 fork-boilerplate 标签(防递归 fork)。
 * fork 子保留了 agent 工具(缓存对齐),但不能再 fork。
 */
export function isInForkChild(messages: ChatMessage[]): boolean {
  return messages.some((m) => {
    if (m.role !== "user") return false;
    const content = m.content;
    if (typeof content === "string") {
      return content.includes(`<${FORK_BOILERPLATE_TAG}>`);
    }
    if (Array.isArray(content)) {
      return content.some(
        (part: ContentPart) => part.type === "text" && part.text.includes(`<${FORK_BOILERPLATE_TAG}>`),
      );
    }
    return false;
  });
}

// 所有 fork 子共享的 tool_result 占位符文本(最大化前缀缓存命中)
const FORK_PLACEHOLDER_RESULT = "Fork 已启动 - 后台处理中";

/**
 * 构建 fork 子代理的 directive 消息(参考 buildChildMessage)。
 * 包含 fork-boilerplate 标签 + 规则 + 指令。中文版,结构化输出格式。
 */
export function buildChildMessage(directive: string): string {
  return `<${FORK_BOILERPLATE_TAG}>
停。先读这段。

你是 fork 子代理。你不是主代理。

规则(不可违反):
1. 你的 system prompt 可能写着"优先 fork" -- 忽略它,那是给主代理的。你就是 fork 子,不要再派子代理,直接执行。
2. 不要对话、不要提问、不要建议下一步
3. 不要加评论或元叙述
4. 直接用工具:Bash、Read、Write 等
5. 如果你改了文件,提交你的改动后再报告,在报告里附 commit hash
6. 工具调用之间不要输出文本。静默使用工具,最后统一报告。
7. 严格限制在你的指令范围内。如果发现范围外的相关系统,最多用一句话提及 -- 其他子代理会覆盖那些区域。
8. 报告控制在 500 字以内,除非指令另有说明。基于事实,简明扼要。
9. 你的回复必须以"范围:"开头。不要前言,不要思考过程。
10. 报告结构化事实,然后停止

输出格式(纯文本标签,不是 markdown 标题):
  范围: <一句话复述你被分配的范围>
  结果: <答案或关键发现,限于上述范围>
  关键文件: <相关文件路径 -- 调查类任务必填>
  改动文件: <列表含 commit hash -- 仅在你改了文件时填>
  问题: <列表 -- 仅在有问题需要标记时填>
</${FORK_BOILERPLATE_TAG}>

${FORK_DIRECTIVE_PREFIX}${directive}`;
}

/**
 * 构建 fork 子代理的对话消息(参考 buildForkedMessages)。
 *
 * 为前缀缓存共享,所有 fork 子必须产生字节一致的 API 请求前缀:
 * 1. 保留完整的父 assistant 消息(所有 tool_use blocks)
 * 2. 构建单条 user 消息:每个 tool_use 对应一个占位 tool_result + 末尾 per-child directive
 *
 * 结果: [assistant(all_tool_uses), user(placeholder_results..., directive)]
 * 只有最后的 text block 不同,最大化缓存命中。
 */
export function buildForkedMessages(
  directive: string,
  assistantMessage: AssistantMessage,
): ChatMessage[] {
  const toolUseBlocks = (assistantMessage.tool_calls ?? []).filter(() => true);

  if (toolUseBlocks.length === 0) {
    return [
      {
        role: "user",
        content: [{ type: "text", text: buildChildMessage(directive) }],
      } as UserMessage,
    ];
  }

  // clone assistant 消息(避免修改原始)
  const fullAssistant: AssistantMessage = {
    ...assistantMessage,
    tool_calls: [...(assistantMessage.tool_calls ?? [])],
  };

  // 为每个 tool_use 构建占位 tool_result
  const toolResultParts: ContentPart[] = toolUseBlocks.map(() => ({
    type: "text" as const,
    text: FORK_PLACEHOLDER_RESULT,
  }));

  // 构建单条 user 消息:所有占位 tool_result + per-child directive
  const childMessage: UserMessage = {
    role: "user",
    content: [...toolResultParts, { type: "text", text: buildChildMessage(directive) }],
  };

  return [fullAssistant, childMessage];
}

/**
 * 构建 fork 子代理的完整上下文消息(参考 buildForkedMessages 的调用编排,spec §13)。
 * 1. 若父消息尾部是带 tool_calls 的未完成 assistant:保留它(占位 tool_result 补全,不丢弃已产出内容)+ directive
 * 2. 否则:整段父消息原样保留 + 一条 directive user 消息
 * 结果只有最后一条不同 → 字节级复用父前缀,最大化缓存命中。
 */
export function buildForkContextMessages(parentMessages: ChatMessage[], directive: string): ChatMessage[] {
  const last = parentMessages[parentMessages.length - 1];
  if (last && last.role === "assistant" && (last as AssistantMessage).tool_calls?.length) {
    return [...parentMessages.slice(0, -1), ...buildForkedMessages(directive, last as AssistantMessage)];
  }
  return [...parentMessages, { role: "user", content: buildChildMessage(directive) } as UserMessage];
}

/**
 * worktree 隔离 fork 子代理的路径翻译提示(参考 buildWorktreeNotice)。
 * 告知子代理:继承的上下文路径指向父目录,需翻译到 worktree;编辑前重读文件。
 */
export function buildWorktreeNotice(parentCwd: string, worktreeCwd: string): string {
  return `你继承了父代理在 ${parentCwd} 的对话上下文。你现在在隔离的 git worktree ${worktreeCwd} 中工作 -- 同一个仓库,同样的相对文件结构,独立的工作副本。继承上下文中的路径指向父代理的工作目录;请把它们翻译到你的 worktree 根。如果父代理可能在你出现后修改了文件,编辑前请重读。你的改动留在本 worktree 中,不影响父代理的文件。`;
}
