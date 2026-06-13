// 把"为其它 agent(Claude Code / Codex / Gemini CLI / Cursor)所写的技能"识别出来。
// 【不再维护翻译字典】——实际转换交给模型(见 convert.ts),目标词表用 dao 自己的工具注册表。
// 这里只做无字典的【结构性检测】:判断一段技能正文是否为他者所写(决定要不要走转换)。

// dao 工具全是 snake_case 小写名;CC 的 CamelCase 工具(Read/Bash/WebFetch/MultiEdit…)、
// Codex/Gemini 的非 dao snake 名(apply_patch/run_shell_command…)、superpowers:xxx 跨引用,
// 结构上即外来。据此无字典判定。
export function isForeignSkill(body: string, daoTools: Set<string>): boolean {
  // 1) 命名空间跨引用:superpowers:xxx / plugin:skill(他者生态特有写法,冒号两侧无空格)。
  if (/(^|[\s`(])[a-z][a-z0-9_-]*:[a-z][a-z0-9-]{2,}\b/.test(body)) return true;
  // 2) 工具调用语境(`反引号` 或 "X tool/工具")里出现的、非 dao 的工具形 token。
  for (const m of body.matchAll(/`([A-Za-z_][\w]*)`|\b([A-Z][a-zA-Z]+|[a-z]+_[a-z_]+)\b\s*(?:tool|工具)/g)) {
    const tok = m[1] ?? m[2];
    if (!tok || daoTools.has(tok)) continue; // dao 自己的工具:不算外来
    if (/^[A-Z]/.test(tok)) return true; // CamelCase 工具形 → dao 没有任何 CamelCase 工具 → 外来
    if (tok.includes("_")) return true; // snake_case 但非 dao 工具(apply_patch / run_shell_command …)
  }
  return false;
}
