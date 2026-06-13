import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// 项目指令文件(对标 CLAUDE.md):dao 自己的 DAO.md 优先,同时兼容跨 agent 的 AGENTS.md 与 Claude Code 的 CLAUDE.md,
// 外加用户级 ~/.dao/DAO.md。存在的全部读取、按内容去重(symlink/复制只取一次)、拼接,供注入系统 prompt 的项目指令插槽。
const PROJECT_FILES = ["DAO.md", "AGENTS.md", "CLAUDE.md"];

export function loadProjectInstructions(workspaceRoot: string): string {
  const candidates: { label: string; file: string }[] = [
    { label: "用户级(~/.dao/DAO.md)", file: path.join(os.homedir(), ".dao", "DAO.md") },
    ...PROJECT_FILES.map((f) => ({ label: f, file: path.join(workspaceRoot, f) })),
  ];
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const { label, file } of candidates) {
    let content: string;
    try { content = readFileSync(file, "utf8").trim(); } catch { continue; } // 不存在/读不了 → 跳过
    if (!content || seen.has(content)) continue; // 空 / 内容重复(symlink/复制)→ 跳过
    seen.add(content);
    parts.push(`### ${label}\n${content}`);
  }
  return parts.join("\n\n");
}
