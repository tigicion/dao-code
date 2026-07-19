import { promises as fs } from "node:fs";
import path from "node:path";
import { globToRegExp } from "../tools/glob.js";
import type { Skill } from "./skills.js";
import { loadSkills } from "./skills.js";

// 动态 skill 发现:文件操作时向上遍历找 .dao/skills/ 目录(参考 CC 的 discoverSkillDirsForPaths)。
// 条件 skill 运行时激活:带 paths frontmatter 的 skill 存入待激活池,文件操作时单文件路径匹配。
// 两者都不碰固定前缀(新 skill 通过尾部 system 消息注入,与 loadInstalledSkills 同框法)。

// 已检查过的目录缓存(避免每次 Read/Write/Edit 都重复 stat 失败路径)。
const checkedDirs = new Set<string>();

/**
 * 从文件路径向上遍历到 cwd(不含 cwd 本身,cwd 级已启动时加载),查找 .dao/skills/ 目录。
 * 返回新发现的目录列表(deepest first,更靠近文件的优先级更高)。
 */
export async function discoverSkillDirsForPath(
  filePath: string,
  cwd: string,
): Promise<string[]> {
  const resolvedCwd = cwd.endsWith(path.sep) ? cwd.slice(0, -1) : cwd;
  const newDirs: string[] = [];

  let currentDir = path.dirname(filePath);
  while (currentDir.startsWith(resolvedCwd + path.sep)) {
    const skillDir = path.join(currentDir, ".dao", "skills");

    if (!checkedDirs.has(skillDir)) {
      checkedDirs.add(skillDir);
      try {
        await fs.stat(skillDir);
        // 目录存在 -> 检查是否被 gitignore(简单检查:路径含 node_modules 则跳过)
        if (currentDir.includes("node_modules")) continue;
        newDirs.push(skillDir);
      } catch {
        // 目录不存在 -> 已记录,继续
      }
    }

    const parent = path.dirname(currentDir);
    if (parent === currentDir) break; // 到根了
    currentDir = parent;
  }

  // deepest first
  return newDirs.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
}

/**
 * 从发现的目录加载 skill,返回之前未知的(按 name 去重)。
 */
export async function loadSkillsFromDirs(
  dirs: string[],
  knownNames: Set<string>,
): Promise<Skill[]> {
  if (dirs.length === 0) return [];
  const loaded = await loadSkills(...dirs);
  return loaded.filter((s) => !knownNames.has(s.name.toLowerCase()));
}

/**
 * 条件 skill 池:启动时带 paths 的 skill 存入此处,运行时文件操作时按路径匹配激活。
 */
const conditionalSkills = new Map<string, { skill: Skill; regexps: RegExp[] }>();
const activatedNames = new Set<string>();

/** 初始化条件 skill 池:把带 paths 的 skill 存入待激活池(不进启动时可见列表)。 */
export function initConditionalPool(skills: Skill[]): Skill[] {
  const unconditional: Skill[] = [];
  for (const s of skills) {
    if (s.paths && s.paths.length > 0 && !activatedNames.has(s.name)) {
      const regexps = s.paths.map(globToRegExp);
      conditionalSkills.set(s.name, { skill: s, regexps });
    } else {
      unconditional.push(s);
    }
  }
  return unconditional;
}

/**
 * 检查被操作的文件路径是否匹配某个待激活 skill 的 paths glob。
 * 匹配上 -> 从待激活池移出,返回新激活的 skill 列表(由调用方注入尾部 system 消息)。
 * 单文件路径匹配,O(skill 数 × 1),开销极小。
 */
export function activateConditionalSkillsForPaths(
  filePaths: string[],
  cwd: string,
): Skill[] {
  if (conditionalSkills.size === 0) return [];
  const activated: Skill[] = [];

  for (const [name, { skill, regexps }] of conditionalSkills) {
    for (const filePath of filePaths) {
      const rel = path.isAbsolute(filePath) ? path.relative(cwd, filePath) : filePath;
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
      if (regexps.some((re) => re.test(rel))) {
        conditionalSkills.delete(name);
        activatedNames.add(name);
        activated.push(skill);
        break; // 匹配一个文件即可
      }
    }
  }

  return activated;
}

/** 重置所有状态(测试用)。 */
export function resetDiscoveryState(): void {
  checkedDirs.clear();
  conditionalSkills.clear();
  activatedNames.clear();
}

/** 获取待激活池中尚未激活的 skill 数(测试/调试用)。 */
export function pendingConditionalCount(): number {
  return conditionalSkills.size;
}
