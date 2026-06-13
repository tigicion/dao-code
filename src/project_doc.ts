import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// 项目指令文件(对标 CLAUDE.md)。规则:
//   用户级 ~/.dao/DAO.md 始终加载(dao 自己的跨项目偏好);
//   项目级——【有 DAO.md 就只读 DAO.md,不做兼容】;没有 DAO.md 才回退兼容 AGENTS.md → CLAUDE.md(取第一个存在的)。
//   按内容去重(symlink/复制只取一次),带来源标签拼接,注入系统 prompt 的项目指令插槽。
export function loadProjectInstructions(workspaceRoot: string): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const read = (label: string, file: string) => {
    try {
      const c = readFileSync(file, "utf8").trim();
      if (c && !seen.has(c)) { seen.add(c); parts.push(`### ${label}\n${c}`); }
    } catch { /* 不存在/读不了 */ }
  };

  read("用户级(~/.dao/DAO.md)", path.join(os.homedir(), ".dao", "DAO.md"));

  const daoMd = path.join(workspaceRoot, "DAO.md");
  if (existsSync(daoMd)) {
    read("DAO.md", daoMd); // 有 DAO.md → 只读它,忽略 AGENTS.md/CLAUDE.md
  } else {
    for (const f of ["AGENTS.md", "CLAUDE.md"]) {
      const p = path.join(workspaceRoot, f);
      if (existsSync(p)) { read(f, p); break; } // 回退:取第一个存在的
    }
  }
  return parts.join("\n\n");
}
