// 内置 prompt 命令(对标 CC 的 bundled skill:slash 命令 → 展开成 prompt,操作员触发、模型用工具执行)。
// 与 .dao/commands 自定义命令同机制,但随 dao 自带、且可现算 prompt。
import { SIMPLIFY_BODY } from "../skills/bundled.js";

export interface BuiltinCommand {
  description: string;
  argHint?: string;
  buildPrompt: (args: string) => string; // 返回空串 = 需要参数(由 runBuiltinCommand 给用法提示)
}

export const BUILTIN_COMMANDS: Record<string, BuiltinCommand> = {
  simplify: {
    description: "审查未提交改动做质量清理(复用/简化/提效/altitude),不抓 bug、不加功能",
    buildPrompt: () => SIMPLIFY_BODY, // 与内置 simplify 技能共用同一份正文
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
  review: {
    description: "审查改动(本地未提交 diff 或 gh PR):查正确性/安全/质量,逐条给 文件:行 + 问题 + 修法",
    argHint: "[PR号]",
    buildPrompt: (a) => {
      const pr = a.trim();
      if (/^\d+$/.test(pr))
        return `审查 GitHub PR #${pr}:用 exec_shell 跑 \`gh pr diff ${pr}\`(必要时 \`gh pr view ${pr}\`)取 diff,逐文件审查正确性 bug、安全隐患、质量问题,按「文件:行 — 问题 — 建议修法」列出,最后给总体结论。只审查报告,不改代码。`;
      return `审查当前未提交改动:先 git status / git diff 看范围,逐处审查——正确性与边界 bug、安全隐患(注入/越权/泄密)、错误处理、质量。按「文件:行 — 问题 — 建议修法」列出每个问题,最后给总体结论(是否可提交)。只审查报告,不改代码。`;
    },
  },
  init: {
    description: "扫描本仓库生成 DAO.md(项目概览/约定/常用命令/测试方式),供以后会话自动加载",
    buildPrompt: () =>
      `为本仓库生成一份 DAO.md 项目指令文件(供 dao 以后每次会话自动加载):
1. 调研仓库:读 README、package.json/pyproject.toml/Cargo.toml/go.mod 等、入口文件、目录结构;若已有 AGENTS.md/CLAUDE.md,吸收其要点。
2. 用 write_file 写 DAO.md,包含:项目用途一句话概述、技术栈、目录结构要点、关键约定(代码风格/命名/测试)、常用命令(构建/测试/运行/lint)、注意事项与坑。
3. 简洁、准确、可执行——别堆砌显而易见的内容。写完告诉用户已生成,可在 DAO.md 里继续调整。`,
  },
  "security-review": {
    description: "对当前改动做安全审查:注入/密钥泄露/越权/路径穿越/不安全反序列化等,逐条给风险+修法",
    argHint: "[PR号]",
    buildPrompt: (a) => {
      const pr = a.trim();
      const target = /^\d+$/.test(pr) ? `用 exec_shell 跑 \`gh pr diff ${pr}\` 取 PR diff` : "先 git status / git diff 看当前未提交改动";
      return `对改动做【安全审查】(只看安全,不做风格清理):${target}。重点排查:命令/SQL/模板注入、密钥与凭据泄露(硬编码/写日志)、认证与越权、路径穿越与任意文件读写、不安全反序列化/eval、SSRF、输入校验缺失、依赖风险。按「文件:行 — 风险 — 影响 — 修法」逐条列出,最后给总体风险结论。只报告,不改代码。`;
    },
  },
  batch: {
    description: "把一个大改拆成独立子任务,并行派 worktree 隔离子代理各自实现(真 agent 并发)",
    argHint: "<大改动指令>",
    buildPrompt: (a) =>
      a.trim()
        ? `把下面这个较大的改动做成【并行 agent 工作流】:
1. 先调研、理清范围,把它拆成【相互独立、触及不相交文件】的子任务(≤6 个;耦合的、要改同一文件的不要拆开)。
2. 用 agent 工具一次性 tasks:[...] + isolate:true 并行派发——每个子代理在独立 git worktree+分支里实现自己那块,互不冲突。
3. 每个子任务描述要【自包含】(子代理看不到当前对话):交代背景、目标、产出、约束、用 dao 工具名。
4. 汇总各分支结果,说明每个分支改了什么、如何 review/合并;有冲突或遗漏就指出。
若任务本质上耦合(无法拆成不相交文件),【不要硬并行】,直接在主线程做并说明原因。
改动指令:${a.trim()}`
        : "",
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
