import { promises as fs, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";

const exec = promisify(execFile);

// 插件 = ~/.dao/plugins/<名>/ 目录,含 plugin.json({name, description})。
// 可携带多种组件:skills/、commands/、agents/、hooks.json(均与 .dao/ 下同格式)。
// 基础能力:安装(git/本地)、列出、删除;各组件复用现有加载器并入对应注册表。
export interface PluginInfo {
  name: string;
  description: string;
  dir: string;
  skillsDir: string; // <plugin>/skills,交给 loadSkills 加载
  commandsDir?: string; // <plugin>/commands(存在时),.md 自定义命令,同 .dao/commands
  agentsDir?: string; // <plugin>/agents(存在时),.md 代理定义,同 .dao/agents
  hooksFile?: string; // <plugin>/hooks.json(存在时),同 .dao/hooks.json
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
    const info: PluginInfo = { name: manifest.name ?? name, description: manifest.description ?? "", dir, skillsDir: path.join(dir, "skills") };
    const commandsDir = path.join(dir, "commands");
    if (existsSync(commandsDir)) info.commandsDir = commandsDir;
    const agentsDir = path.join(dir, "agents");
    if (existsSync(agentsDir)) info.agentsDir = agentsDir;
    const hooksFile = path.join(dir, "hooks.json");
    if (existsSync(hooksFile)) info.hooksFile = hooksFile;
    out.push(info);
  }
  return out;
}

// 聚合所有插件的各组件目录/文件(过滤 undefined),供 index.ts 并入对应注册表。
export function pluginComponentDirs(plugins: PluginInfo[]): {
  skillDirs: string[];
  commandDirs: string[];
  agentDirs: string[];
  hookFiles: string[];
} {
  const skillDirs: string[] = [];
  const commandDirs: string[] = [];
  const agentDirs: string[] = [];
  const hookFiles: string[] = [];
  for (const p of plugins) {
    skillDirs.push(p.skillsDir);
    if (p.commandsDir) commandDirs.push(p.commandsDir);
    if (p.agentsDir) agentDirs.push(p.agentsDir);
    if (p.hooksFile) hookFiles.push(p.hooksFile);
  }
  return { skillDirs, commandDirs, agentDirs, hookFiles };
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
