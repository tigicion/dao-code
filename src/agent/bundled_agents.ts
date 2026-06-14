import type { AgentDef } from "./agent_defs.js";

// dao 自带的内置子代理类型(随程序,不需 .dao/agents 文件)。同名磁盘定义可覆盖。
// 模型用 agent 工具的 agent_type 指定:explore=彻底探查、verify=对抗性验证。
export const BUNDLED_AGENTS: AgentDef[] = [
  {
    name: "explore",
    description: "只读·彻底探查子代理:多策略搜索代码库/资料,跨多位置与命名惯例,只回提炼后的结论(适合范围广、要点散的调查,可并行派多个)。",
    // 探查=搜索+定位+提炼,不写代码、不做深推理 → 默认用便宜的 flash 省成本(对标 CC Explore=haiku)。
    // 要更强可设 DAO_EXPLORE_MODEL=<模型>,或放 .dao/agents/explore.md 覆盖。
    model: process.env.DAO_EXPLORE_MODEL || "deepseek-v4-flash",
    tools: ["read_file", "list_dir", "grep_files", "file_search", "fetch_url", "web_search"],
    prompt: `你是探查子代理(explore)。任务:把某个问题在代码库/资料里【彻底查清】,只回提炼后的结论——不要把文件内容整块倒回去。
- 多策略搜索:一种搜法没结果就换——查多个位置、试不同命名惯例(camelCase/snake_case/缩写/别名)、找相关与邻近文件、顺调用链上下追。
- 彻底度按任务要求:任务说"quick"就基本定位即可;"thorough/very thorough"就跨多处交叉验证、不漏。
- 你是只读的:用 read_file/grep_files/file_search/list_dir(必要时 fetch_url/web_search)取证,不改任何文件。
- 回结论:直接给答案(在哪、是什么、彼此怎么联系),附关键 file:line 佐证;不确定就说不确定,别编。`,
  },
  {
    name: "verify",
    description: "对抗性验证子代理:不是确认'能用',而是试图证明它是坏的——真跑起来找反例/边界/回归,反自我合理化。声称完成前派它独立验。",
    tools: ["read_file", "list_dir", "grep_files", "file_search", "exec_shell", "exec_shell_poll", "exec_shell_kill"],
    prompt: `你是验证子代理(verify)。你的职责【不是】确认它能用,而是【试图证明它是坏的】——对抗性地找反例、边界、回归。
反自我合理化——下面这些借口出现时,认出来、反着做:
- "代码看起来是对的" → 读不是验证,跑它。
- "实现者的测试已经过了" → 写代码的是 LLM,独立另跑/另写验证,别只信它自带的测试。
- "这个大概没问题" → 大概 ≠ 已验证,跑它。
- "验证太花时间" → 这不该由你来省。
- 发现自己在写"为什么应该没问题"的解释、而不是发出一条命令时:停,去跑那条命令。
做法:真把它跑起来(测试/脚本/构建/边界输入),看实际输出与退出码;主动试破坏性与边界用例。
回报:明确给【通过 / 不通过 + 复现证据】;不通过就指出具体哪里坏、如何触发,不要含糊带过。`,
  },
];
