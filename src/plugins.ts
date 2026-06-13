import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";

const exec = promisify(execFile);

// 插件 = ~/.dao/plugins/<名>/ 目录,含 plugin.json({name, description})+ skills/ 子目录。
// 基础能力:安装(git/本地)、列出、删除;插件的 skills 复用现有 skill 加载器并入技能集。
export interface PluginInfo {
  name: string;
  description: string;
  dir: string;
  skillsDir: string; // <plugin>/skills,交给 loadSkills 加载
}

export function pluginsRoot(): string {
  return path.join(os.homedir(), ".dao", "plugins");
}

// 扫描 plugins 根,读每个子目录的 plugin.json;无 manifest 的跳过。
export async function loadPlugins(root = pluginsRoot()): Promise<PluginInfo[]> {
  let names: string[] = [];
  try {
    names = (await fs.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const out: PluginInfo[] = [];
  for (const name of names) {
    const dir = path.join(root, name);
    let manifest: { name?: string; description?: string };
    try {
      manifest = JSON.parse(await fs.readFile(path.join(dir, "plugin.json"), "utf8"));
    } catch {
      continue; // 缺/坏 manifest → 不是插件
    }
    out.push({ name: manifest.name ?? name, description: manifest.description ?? "", dir, skillsDir: path.join(dir, "skills") });
  }
  return out;
}

// 安装:git URL 或本地路径 → ~/.dao/plugins/<manifest.name>。要求含 plugin.json。
export async function installPlugin(source: string, write: (s: string) => void): Promise<void> {
  const root = pluginsRoot();
  await fs.mkdir(root, { recursive: true });
  let src = source;
  let tmp: string | undefined;
  if (/^(https?:|git@)/.test(source)) {
    const t = await fs.mkdtemp(path.join(os.tmpdir(), "dao-plugin-"));
    tmp = t;
    write(`拉取 ${source} …\n`);
    await exec("git", ["clone", "--depth", "1", source, t]);
    src = t;
  }
  let manifest: { name?: string };
  try {
    manifest = JSON.parse(await fs.readFile(path.join(src, "plugin.json"), "utf8"));
  } catch {
    write("缺 plugin.json(插件根目录需有 {\"name\":\"…\",\"description\":\"…\"})。\n");
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
    return;
  }
  if (!manifest.name) {
    write("plugin.json 缺 name。\n");
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
    return;
  }
  const dest = path.join(root, manifest.name);
  await fs.rm(dest, { recursive: true, force: true }); // 重装覆盖
  await fs.cp(src, dest, { recursive: true });
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  let skills = 0;
  try {
    skills = (await fs.readdir(path.join(dest, "skills"), { withFileTypes: true })).filter((e) => e.isDirectory()).length;
  } catch { /* 无 skills 目录 */ }
  write(`✓ 安装插件 ${manifest.name} → ${dest}(贡献 ${skills} 个技能)。重启 dao 生效。\n`);
}

export async function removePlugin(name: string, write: (s: string) => void): Promise<void> {
  const dest = path.join(pluginsRoot(), name);
  try {
    await fs.access(dest);
  } catch {
    write(`未找到插件:${name}\n`);
    return;
  }
  await fs.rm(dest, { recursive: true, force: true });
  write(`✓ 已删除插件 ${name}。重启 dao 生效。\n`);
}
