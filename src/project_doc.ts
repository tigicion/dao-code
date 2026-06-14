import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// 项目指令文件(对标 CLAUDE.md)。规则:
//   用户级 ~/.dao/DAO.md 始终加载(dao 自己的跨项目偏好);
//   项目级——从 cwd【向上溯到 git 根】逐级收集(monorepo:外层通用 + 内层特定),越靠近 cwd 越具体、优先级越高;
//     每级:有 DAO.md 就只读 DAO.md(不做兼容),没有才回退 AGENTS.md → CLAUDE.md(取第一个存在的);
//     再叠加同级 DAO.local.md(私有、不提交 git 的本地指令,优先级高于该级 DAO.md);
//   按内容去重(symlink/复制/上下级重复只取一次),带来源标签拼接,注入系统 prompt 的项目指令插槽。
//
// 输出顺序 = 低→高优先级(通用在前、具体在后):用户级 → git根 … → cwd;同级里 DAO.md 在前、DAO.local.md 在后。

// 从 start 向上找 git 根:返回 [git根, …, start](start 最后=最具体)。
// 没找到 .git(到文件系统根仍无)→ 不上溯,只用 start(避免扫到无关父目录)。
function projectChain(start: string): string[] {
  const chain: string[] = [];
  let dir = path.resolve(start);
  for (;;) {
    chain.push(dir);
    if (existsSync(path.join(dir, ".git"))) break; // 到 git 根,停(含本级)
    const parent = path.dirname(dir);
    if (parent === dir) return [path.resolve(start)]; // 到根仍无 .git → 只用 start
    dir = parent;
  }
  return chain.reverse();
}

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

  for (const dir of projectChain(workspaceRoot)) {
    const rel = path.relative(workspaceRoot, dir) || "."; // cwd 本级标 ".",祖先标相对路径
    const daoMd = path.join(dir, "DAO.md");
    if (existsSync(daoMd)) {
      read(`DAO.md @ ${rel}`, daoMd); // 有 DAO.md → 只读它,忽略本级 AGENTS.md/CLAUDE.md
    } else {
      for (const f of ["AGENTS.md", "CLAUDE.md"]) {
        const p = path.join(dir, f);
        if (existsSync(p)) { read(`${f} @ ${rel}`, p); break; } // 回退:取第一个存在的
      }
    }
    read(`DAO.local.md @ ${rel}`, path.join(dir, "DAO.local.md")); // 私有本地指令,优先级高于本级 DAO.md
  }
  return parts.join("\n\n");
}
