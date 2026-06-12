import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { adaptSkillBody } from "./adapt.js";

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
  for (const skillDir of found) {
    const name = path.basename(skillDir);
    const body = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
    if (!body.trimStart().startsWith("---")) { warnings.push(`${name}:缺 frontmatter,跳过`); continue; }
    await fs.cp(skillDir, path.join(dest, name), { recursive: true });
    installed++;
    // 自主识别:扫描外来工具名/跨引用,装载时会自动加平台对照,这里先告知。
    const a = adaptSkillBody(body);
    const marks = [...a.glossary, a.namespaced ? "superpowers: 跨引用" : ""].filter(Boolean);
    if (marks.length) warnings.push(`${name}:含外来痕迹(${marks.join("、")})——装载时自动加平台对照`);
  }
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });

  write(`✓ 安装 ${installed} 个技能 → ${dest}(${scope === "user" ? "用户级,跨项目可用" : "项目级,仅本项目"})\n`);
  if (warnings.length) write("注意:\n" + warnings.map((w) => "  - " + w).join("\n") + "\n");
  write("(重启 dao 生效;启动只列 name+description,模型按需用 skill 工具加载正文,外来工具名会自动对照)\n");
}
