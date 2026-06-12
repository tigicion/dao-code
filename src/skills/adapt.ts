// 把为其它 agent(主要 Claude Code,也含 Codex/Gemini)写的技能正文,适配到 dao 的工具词表。
// 不改写正文(裸词 Read/Edit/Bash 在散文里到处是,全局替换会改坏文本),
// 而是【探测正文里确实出现的外来工具名】,生成一小段对照表,装载时追加在正文前——源文件保持原样(可跟上游)。

const ALIASES: Record<string, string> = {
  Read: "read_file", Write: "write_file", Edit: "edit_file", MultiEdit: "multi_edit",
  Bash: "exec_shell", Grep: "grep_files", Glob: "file_search", LS: "list_dir",
  WebFetch: "fetch_url", WebSearch: "web_search", Task: "agent", TodoWrite: "todo_write",
  NotebookEdit: "notebook_edit", AskUserQuestion: "ask_user",
  // 其它来源常见名:
  View: "read_file", Shell: "exec_shell",
};
// 无歧义名(多词/CamelCase):正文里任意出现都算工具引用。
const UNAMBIGUOUS = new Set(["MultiEdit", "WebFetch", "WebSearch", "TodoWrite", "NotebookEdit", "AskUserQuestion"]);

export interface SkillAdaptation {
  glossary: string[]; // 形如 "Read → read_file"
  namespaced: boolean; // 是否含 superpowers: 跨引用
}

// 探测正文用到的外来工具名 + 跨引用。歧义词(Read/Bash/Edit…)仅在 `反引号` 或 "X tool/工具" 语境下才算,避免散文误报。
export function adaptSkillBody(body: string): SkillAdaptation {
  const present: string[] = [];
  for (const name of Object.keys(ALIASES)) {
    const hit = UNAMBIGUOUS.has(name)
      ? new RegExp(`\\b${name}\\b`).test(body)
      : new RegExp("`" + name + "`|\\b" + name + "\\b\\s*(?:tool|工具)").test(body);
    if (hit) present.push(`${name} → ${ALIASES[name]}`);
  }
  return { glossary: present, namespaced: /superpowers:/.test(body) };
}

// 据探测结果生成"本平台适配"提示;无命中返回空串(不污染上下文)。
export function adaptNote(a: SkillAdaptation): string {
  if (a.glossary.length === 0 && !a.namespaced) return "";
  const lines = ["## 本平台适配(此技能为其它 agent 所写,按下列对照执行)"];
  if (a.glossary.length) lines.push(`- 工具名:正文出现的是外来名,改用对应 dao 工具 —— ${a.glossary.join("、")}`);
  if (a.namespaced) lines.push("- 跨引用 `superpowers:xxx` 在 dao 里按裸名 `xxx` 加载。");
  return lines.join("\n") + "\n\n";
}
