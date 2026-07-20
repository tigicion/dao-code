// auto 模式危险 allow 规则检测(参考 CC dangerousPatterns.ts + isDangerousBashPermission)。
// 一条 allow 规则如 Bash(python:*) 会让模型通过解释器执行任意代码,绕过 auto 模式分类器。
// auto 模式下这类规则应被降级为 ask(交分类器),而不是直接放行。

// 代码执行入口:解释器、包运行器、shell、远程命令 wrapper。
const DANGEROUS_BASH_PATTERNS: readonly string[] = [
  // 解释器
  "python", "python3", "python2",
  "node", "deno", "tsx",
  "ruby", "perl", "php", "lua",
  // 包运行器
  "npx", "bunx",
  "npm run", "yarn run", "pnpm run", "bun run",
  // shell(可通过 -c 执行任意命令)
  "bash", "sh", "zsh", "fish",
  // 远程任意命令 wrapper
  "ssh",
  // 动态执行 / 环境注入 / 提权
  "eval", "exec", "env", "xargs", "sudo",
];

/**
 * 判断一条 Bash allow 规则是否"危险"(会在 auto 模式下绕过分类器)。
 * @param ruleSpec 规则的 specifier 部分,如 "python:*" 中的 "python:*"。
 *                 裸工具名规则(Bash 无 specifier)传 undefined。
 * @returns true=危险,auto 模式应降级为 ask。
 */
export function isDangerousBashPermission(ruleSpec: string | undefined): boolean {
  // 裸 Bash(无 specifier)或 Bash(*) -> 允许所有命令,最危险
  if (ruleSpec === undefined || ruleSpec === "") return true;
  const content = ruleSpec.trim().toLowerCase();
  if (content === "*") return true;

  for (const pattern of DANGEROUS_BASH_PATTERNS) {
    const p = pattern.toLowerCase();
    // 精确匹配:"python"
    if (content === p) return true;
    // 前缀语法:"python:*"
    if (content === `${p}:*`) return true;
    // 通配结尾:"python*"
    if (content === `${p}*`) return true;
    // 空格通配:"python *"
    if (content === `${p} *`) return true;
    // flag 通配:"python -*"(如 python -c 'code')
    if (content.startsWith(`${p} -`) && content.endsWith("*")) return true;
  }
  return false;
}
