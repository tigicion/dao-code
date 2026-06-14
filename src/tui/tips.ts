// 一句话引导:梳理 dao 的命令/技能/能力,随机展示(欢迎屏一条 + 输入框下轮换)。克制、无 emoji。
export const TIPS: string[] = [
  "输入 / 看全部命令 · @ 引用文件 · Shift+Tab 切权限模式 · Esc 打断",
  "新项目先 /init —— 扫描仓库生成 DAO.md,以后每次会话自动加载项目约定",
  "/skills 看可用技能;dao skill add <git> 装一套(如 superpowers),会自动适配工具名",
  "dao plugin add <git> 装插件 —— 一个插件可打包多个技能",
  "/context 看上下文占用;接近上限会自动压缩,也可手动 /compact",
  "/rewind 回退对话;/rewind <n> code 连文件一起回滚(影子 git,不动你的真实 git 提交)",
  "/restore 把工作区文件回退到上一个检查点;回退前会自动存档,可再找回",
  "/resume 列出历史会话并载入其上下文;/branch 存分支,/rename 命名会话",
  "/diff 看未提交改动;/review 让 dao 审一遍(也能审 gh PR);/security-review 查安全",
  "大任务:/task 自主连续推进,或 /coordinator 研究→综合→实现→验证 多 agent 编排",
  "/batch 把大改拆给多个 worktree 子代理并行做,各自一个分支",
  "/loop 5m <要做的事> 会话内周期跑;dao schedule 用本地 cron 定时跑",
  "Shift+Tab 循环权限模式:默认 → auto(AI 裁决) → 规划;接受编辑用 /mode acceptEdits 进",
  "/bypass 免审批(慎用);deny 规则与敏感路径(.ssh/.git/凭据…)仍会拦你",
  "dao 会自动记忆;/remember <事> 手动记一条,/memory 看用户/知识/项目三层记忆",
  "/effort 调思考强度(low/medium/high/max);/cost 看用量与缓存命中率",
  "粘贴大段文字会自动折叠成占位;/copy 复制最后一条回答到剪贴板",
  "卡住了?/debug 读会话日志诊断;/doctor 自检环境(API key / PATH / 二进制签名)",
  "可让 dao 派 explore 子代理彻底查、verify 子代理对抗性验证(它会真跑起来找反例)",
  "/simplify 清理刚改的代码(只质量不抓 bug);/skillify 把本次经验提炼成技能",
  "/tasks 看后台子代理;/mcp 看已连 MCP 服务器;/agents 看可用子代理类型",
  "运行中可继续输入,回车排队执行;Esc 随时优雅打断(模型流与 shell 一起停)",
];

export function randomTip(): string {
  return TIPS[Math.floor(Math.random() * TIPS.length)] ?? TIPS[0]!;
}
