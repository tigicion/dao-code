import type { ToolCall } from "../client/types.js";
import type { Skill } from "./skills.js";
import { globToRegExp } from "../tools/glob.js";

// 条件(路径触发)技能:有 frontmatter paths 的技能不进常驻列表,仅当模型读/写匹配文件时
// 确定性激活并自动注入正文。这是 DAO 比 CC 更硬的一处——CC 命中只"可见",DAO 命中直接把约定喂进上下文。

// 会触发条件技能的"操作具体文件"的工具(对标 CC 的 FileRead/FileWrite/FileEdit);
// grep/list/file_search 的 path 是搜索目录而非被操作文件,不计入。
const FILE_TOOLS = new Set(["read_file", "write_file", "edit_file", "multi_edit"]);

// 从一批工具调用里取出被操作的文件路径(相对工作区根)。坏 JSON 静默跳过。
export function extractOperatedPaths(calls: ToolCall[]): string[] {
  const out: string[] = [];
  for (const c of calls) {
    if (!FILE_TOOLS.has(c.function.name)) continue;
    try {
      const p = JSON.parse(c.function.arguments)?.path;
      if (typeof p === "string" && p) out.push(p);
    } catch { /* 坏 JSON:跳过 */ }
  }
  return out;
}

// gitignore 风格匹配:无斜杠的模式按 basename 任意层命中(*.tsx 匹配 src/a/b.tsx);
// 含斜杠的模式按根相对路径命中(src/api/** 从根锚定)。
export function matchPath(relPath: string, patterns: string[]): boolean {
  const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const base = norm.split("/").pop() ?? norm;
  for (const pat of patterns) {
    const p = pat.replace(/^\.?\//, "");
    const target = p.includes("/") ? norm : base;
    if (globToRegExp(p).test(target)) return true;
  }
  return false;
}

export interface Activator {
  // 给定本轮操作的文件路径,返回【新激活】的条件技能(已激活的不再返回);标记其为已激活。
  activate(paths: string[]): Skill[];
  activated(): Set<string>;
}

// 持有条件技能 + 已激活集合;activate 幂等(每个技能至多激活一次,正文只注入一次)。
export function makeActivator(conditional: Skill[]): Activator {
  const done = new Set<string>();
  return {
    activate(paths) {
      if (paths.length === 0) return [];
      const fresh: Skill[] = [];
      for (const sk of conditional) {
        if (done.has(sk.name) || !sk.paths) continue;
        if (paths.some((p) => matchPath(p, sk.paths!))) {
          done.add(sk.name);
          fresh.push(sk);
        }
      }
      return fresh;
    },
    activated: () => done,
  };
}

// 把新激活的条件技能渲染成注入上下文的系统消息正文(自动加载——不依赖模型去调 skill 工具)。
export function formatActivation(fresh: Skill[]): string {
  if (fresh.length === 0) return "";
  return fresh
    .map(
      (s) =>
        `[条件技能已自动激活:你正在操作匹配 ${s.paths!.join("/")} 的文件,以下约定即时生效]\n` +
        `# Skill: ${s.name}\n${s.body}`,
    )
    .join("\n\n");
}
