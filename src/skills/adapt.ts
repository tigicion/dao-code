// 把"为其它 agent(Codex / Gemini CLI / Cursor)所写的技能"识别出来。
// CC 技能不需要转换--DAO 工具名已对齐 CC PascalCase(Read/Bash/Edit/Grep...),原样可用。
// 只检测非 CC 生态的外来技能:Codex 的 apply_patch/run_shell_command、Gemini 的 activate_skill 等。
export function isForeignSkill(body: string, daoTools: Set<string>): boolean {
  // 1) 命名空间跨引用:superpowers:xxx / plugin:skill(他者生态特有写法,冒号两侧无空格)。
  if (/(^|[\s`(])[a-z][a-z0-9_-]*:[a-z][a-z0-9-]{2,}\b/.test(body)) return true;
  // 2) 工具调用语境(`反引号` 或 "X tool/工具")里出现的、非 dao 的工具形 token。
  for (const m of body.matchAll(/`([A-Za-z_][\w]*)`|\b([A-Z][a-zA-Z]+|[a-z]+_[a-z_]+)\b\s*(?:tool|工具)/g)) {
    const tok = m[1] ?? m[2];
    if (!tok || daoTools.has(tok)) continue; // dao 自己的工具:不算外来
    // snake_case 工具名(Codex/Gemini 风格,如 apply_patch / run_shell_command / activate_skill)
    if (tok.includes("_")) return true;
    // CamelCase 工具名但非 dao 工具(可能是其它平台的工具名)
    if (/^[A-Z]/.test(tok)) return true;
  }
  return false;
}
