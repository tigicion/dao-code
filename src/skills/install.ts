import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { BUNDLED_SKILLS } from "./bundled.js";

const exec = promisify(execFile);

// 安装技能:从 git URL 或本地路径,把含 SKILL.md 的技能目录复制到目标层(user 跨项目 / project 仅本项目),
// 校验 frontmatter、扫描外来工具名/跨引用并报告(供"自主识别适配")。操作员命令 `dao skill add` 用。
export async function installSkills(
  source: string,
  scope: "user" | "project",
  workspaceRoot: string,
  write: (s: string) => void,
): Promise<void> {
  const dest = scope === "user"
    ? path.join(os.homedir(), ".dao", "skills")
    : path.join(workspaceRoot, ".dao", "skills");

  let srcRoot = source;
  let tmp: string | undefined;
  if (/^(https?:|git@)/.test(source)) {
    const t = await fs.mkdtemp(path.join(os.tmpdir(), "dao-skill-"));
    tmp = t;
    write(`拉取 ${source} …\n`);
    await exec("git", ["clone", "--depth", "1", source, t]);
    // 技能常在 skills/ 子目录,否则用仓库根。
    srcRoot = await fs.stat(path.join(t, "skills")).then(() => path.join(t, "skills")).catch(() => t);
  }

  // 递归找含 SKILL.md 的目录(每个就是一个技能)。
  const found: string[] = [];
  const scan = async (dir: string) => {
    if (await fs.stat(path.join(dir, "SKILL.md")).then(() => true).catch(() => false)) { found.push(dir); return; }
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory()) await scan(path.join(dir, e.name));
    }
  };
  await scan(srcRoot);

  if (found.length === 0) {
    write("未找到任何含 SKILL.md 的技能。\n");
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
    return;
  }

  await fs.mkdir(dest, { recursive: true });
  let installed = 0;
  const warnings: string[] = [];
  const installedNames: string[] = [];
  for (const skillDir of found) {
    const name = path.basename(skillDir);
    const body = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
    if (!body.trimStart().startsWith("---")) { warnings.push(`${name}:缺 frontmatter,跳过`); continue; }
    await fs.cp(skillDir, path.join(dest, name), { recursive: true });
    installed++;
    installedNames.push(name);
  }
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });

  write(`✓ 安装 ${installed} 个技能 → ${dest}(${scope === "user" ? "用户级,跨项目可用" : "项目级,仅本项目"})\n`);
  if (warnings.length) write("注意:\n" + warnings.map((w) => "  - " + w).join("\n") + "\n");
  // 同名覆盖内置:确定性提示(无模糊匹配,不误报)。提醒可在 /skills 取舍,避免触发被稀释。
  const bundledNames = new Set(BUNDLED_SKILLS.filter((b) => b.core).map((b) => b.name));
  const shadowed = installedNames.filter((n) => bundledNames.has(n));
  if (shadowed.length) {
    write(`提示:${shadowed.map((n) => `'${n}'`).join("、")} 覆盖了内置同名技能(你的版本生效)。若不想覆盖,可 /skills off ${shadowed[0]} 关掉你装的这个;内置技能本身也可 /skills off <名> 关。\n`);
  }
  write("(重启 dao 生效;启动只列 name+description,模型按需用 skill 工具加载正文。若为其它 agent 所写,首次加载时自动按用途转换工具名并缓存)\n");
}
