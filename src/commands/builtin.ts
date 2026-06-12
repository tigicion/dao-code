// 内置 prompt 命令(对标 CC 的 bundled skill:slash 命令 → 展开成 prompt,操作员触发、模型用工具执行)。
// 与 .dao/commands 自定义命令同机制,但随 dao 自带、且可现算 prompt。

export interface BuiltinCommand {
  description: string;
  argHint?: string;
  buildPrompt: (args: string) => string; // 返回空串 = 需要参数(由 runBuiltinCommand 给用法提示)
}

export const BUILTIN_COMMANDS: Record<string, BuiltinCommand> = {
  simplify: {
    description: "审查未提交改动做质量清理(复用/简化/提效/altitude),不抓 bug、不加功能",
    buildPrompt: () =>
      `对当前未提交的改动做质量清理(只做质量,不找 bug、不加功能):
1. 先看 git status / git diff 确认改了什么。
2. 按这些维度清理:复用(消除重复、用现有工具/函数)、简化(去冗余、收敛分支)、提效(明显低效处)、altitude(把逻辑放到正确的层/抽象级)。
3. 逐处用 edit_file/multi_edit 落地,并简述理由。
4. 改完跑相关测试/构建确认没改坏。`,
  },
  remember: {
    description: "记一条跨会话记忆(自动判断类型与归属层)",
    argHint: "<要记住的事实>",
    buildPrompt: (a) =>
      a.trim()
        ? `用 memory_write 记住下面这条事实,自行判断 type(user 用户信息/feedback 工作方式/procedural 跨项目知识/semantic 项目事实/episodic 项目进展)与归属层:
${a.trim()}`
        : "",
  },
  debug: {
    description: "读最近会话日志诊断问题",
    argHint: "[问题描述]",
    buildPrompt: (a) =>
      `诊断 dao 最近一次会话的问题。步骤:
1. list_dir .dao/sessions,挑时间戳最大的会话目录。
2. read_file 它的 events.jsonl(事件流)与 state.json(末态 + usage)。
3. 找异常:报错、未结束的回合(缺 turn_end)、卡死迹象、token/上下文异常。
4. 用平实语言说明发现 + 给下一步。
${a.trim() ? `重点关注:${a.trim()}` : "(未指明问题,请总结日志中的异常)"}`,
  },
  skillify: {
    description: "把本次会话经验提炼成一个 dao 技能写入 .dao/skills",
    argHint: "[技能名]",
    buildPrompt: (a) =>
      `把本次会话中可复用的经验提炼成一个 dao 技能:
1. 总结这段对话里值得固化、跨会话可复用的做法/流程/坑(别记一次性细节)。
2. 写到 .dao/skills/<kebab-name>/SKILL.md,带 frontmatter:name、description(写清"何时该用",触发判断靠它)。
3. 正文用 dao 的工具名(read_file/edit_file/exec_shell/grep_files/file_search/agent…),不要用其它 agent 的工具名。
${a.trim() ? `建议技能名:${a.trim()}` : "技能名据内容自拟。"}`,
  },
};

// 命中内置命令则返回 {prompt}(跑一回合)或 {output}(缺参数给用法);否则 null。
export function runBuiltinCommand(name: string, args: string): { prompt?: string; output?: string } | null {
  const c = BUILTIN_COMMANDS[name];
  if (!c) return null;
  const prompt = c.buildPrompt(args);
  if (!prompt) return { output: `用法:/${name} ${c.argHint ?? ""}`.trim() };
  return { prompt };
}
