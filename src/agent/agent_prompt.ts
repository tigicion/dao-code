// src/agent/agent_prompt.ts
import type { AgentDef } from "./agent_defs.js";

/**
 * 格式化单行 agent 描述(用于 agent 列表)。
 * 格式: - <type>: <whenToUse> (Tools: <tools>)
 */
export function formatAgentLine(agent: AgentDef): string {
  const toolsDescription = getToolsDescription(agent);
  return `- ${agent.agentType}: ${agent.whenToUse} (Tools: ${toolsDescription})`;
}

/**
 * 获取 agent 的工具描述文本。
 * - 有白名单:列出具体工具
 * - 有黑名单:"全部工具除了 X, Y, Z"
 * - 同时有:白名单过滤黑名单后列出
 * - 无限制:"全部工具"
 */
export function getToolsDescription(agent: Pick<AgentDef, "tools" | "disallowedTools">): string {
  const { tools, disallowedTools } = agent;
  const hasAllowlist = tools && tools.length > 0;
  const hasDenylist = disallowedTools && disallowedTools.length > 0;

  if (hasAllowlist && hasDenylist) {
    const denySet = new Set(disallowedTools!);
    const effectiveTools = tools!.filter((t) => !denySet.has(t));
    if (effectiveTools.length === 0) return "无";
    return effectiveTools.join(", ");
  } else if (hasAllowlist) {
    return tools!.join(", ");
  } else if (hasDenylist) {
    return `全部工具除了 ${disallowedTools!.join(", ")}`;
  }
  return "全部工具";
}

/**
 * 生成 agent 工具的描述 prompt(对标 CC getPrompt)。
 */
export function getAgentPrompt(
  agentDefs: AgentDef[],
  allowedAgentTypes?: string[],
): string {
  const effectiveAgents = allowedAgentTypes
    ? agentDefs.filter((a) => allowedAgentTypes.includes(a.agentType))
    : agentDefs;

  const agentListSection = effectiveAgents.length > 0
    ? `可用 agent 类型和它们拥有的工具:
${effectiveAgents.map((agent) => formatAgentLine(agent)).join("\n")}`
    : `当前无可用 agent。`;

  const whenNotToUseSection = `
不该用 agent 工具的场景:
- 读特定文件路径 -> 直接用 read_file
- 按文件名找文件 -> 直接用 file_search
- 搜代码内容(如 "class Foo") -> 直接用 grep_files
- 只在 2-3 个文件里搜代码 -> 直接用 read_file
- 其他不符合上述 agent 描述的任务
`;

  const writingThePromptSection = `
## 写 prompt

像给一个刚走进门的聪明同事 briefing -- 它没看过你的对话,不知道你试过什么,不理解这个任务为什么重要。
- 说清你想做什么、为什么
- 描述你已经知道或排除了什么
- 给足背景让 agent 能做判断,而不是只给窄指令
- 需要简短回复就说("200 字以内报告")
- 查询类:给精确命令。调查类:给问题 -- 预设步骤在前提错误时是死重。

简短的命令式 prompt 产出浅泛的工作。

**永远不要把理解外包。** 不要写"基于你的发现,修 bug"或"基于调研,实现它"。这些话把综合判断推给了 agent 而非你自己做。写能证明你理解的 prompt:包含文件路径、行号、具体改什么。
`;

  const examplesSection = `
示例用法:

<example>
用户: "这个分支还有什么没做完才能发布?"
助手: [调用 agent 工具,agent_type=explore]
agent({
  task: "审查这个分支发布前还剩什么没做完。检查:未提交改动、领先 main 的提交、是否有测试、CI 相关文件是否改了。给出 punch list -- 完成 vs 缺失。200 字以内。"
})
</example>

<example>
用户: "帮我写个素数判断函数"
助手: 用 write_file 写代码后,用 agent 工具派 test-runner agent 跑测试:
agent({
  agent_type: "test-runner",
  task: "运行 npm test 并报告结果"
})
</example>
`;

  return `派发一个新 agent 来自主处理复杂、多步任务。

agent 工具启动专门的子代理(子进程),自主处理复杂任务。每种 agent 类型有特定的能力和可用工具。

${agentListSection}

使用 agent 工具时,指定 agent_type 参数选择使用哪种 agent。省略则用默认通用 agent。

${whenNotToUseSection}

用法说明:
- 始终包含简短描述(3-5 个词),概括 agent 要做什么
- 尽可能并行派发多个 agent 以最大化性能;在单条消息中用多个 agent 工具调用即可
- 可以用 background: true 在后台运行 agent;完成时会自动通知,不要轮询或主动检查进度
- agent 完成后返回单条消息给你;结果对用户不可见,你应向用户发文本消息概述结果
- 用 task_send 向运行中的后台 agent 追加指令;agent 恢复后保留完整上下文
- 可以设 isolate: true 在临时 git worktree 中运行 agent,给它隔离的仓库副本;无改动时自动清理,有改动则返回 worktree 路径和分支
- 如果 agent 描述提到"主动使用",就尽量不等用户先开口就用它
${writingThePromptSection}
${examplesSection}`;
}
