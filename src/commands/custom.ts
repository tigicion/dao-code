import { promises as fs } from "node:fs";
import path from "node:path";

// 自定义 slash 命令:.dao/commands/<name>.md(+ 用户 ~/.dao/commands/)。
// 文件正文是一个 prompt 模板;调用 /name 参数 时,$ARGUMENTS 替换为全部参数、$1/$2.. 替换为第 n 个。
// frontmatter 可选(description)。项目同名覆盖用户。

export interface CustomCommand {
  name: string;
  description: string;
  body: string;
}

function parse(filename: string, raw: string): CustomCommand | null {
  let body = raw;
  let description = "";
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (m) {
    for (const line of m[1]!.split(/\r?\n/)) {
      const i = line.indexOf(":");
      if (i > 0 && line.slice(0, i).trim().toLowerCase() === "description") description = line.slice(i + 1).trim();
    }
    body = (m[2] ?? "").trim();
  } else {
    body = raw.trim();
  }
  if (!body) return null;
  return { name: filename, description, body };
}

async function loadFrom(dir: string): Promise<CustomCommand[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: CustomCommand[] = [];
  for (const f of names) {
    if (!f.endsWith(".md")) continue;
    const raw = await fs.readFile(path.join(dir, f), "utf8").catch(() => "");
    const cmd = parse(f.slice(0, -3), raw);
    if (cmd) out.push(cmd);
  }
  return out;
}

export async function loadCustomCommands(projectDir: string, userDir: string): Promise<Map<string, CustomCommand>> {
  const [user, project] = await Promise.all([loadFrom(userDir), loadFrom(projectDir)]);
  const byName = new Map<string, CustomCommand>();
  for (const c of user) byName.set(c.name, c);
  for (const c of project) byName.set(c.name, c); // 项目覆盖
  return byName;
}

// 展开命令体:$ARGUMENTS→全部参数;$1/$2..→第 n 个参数。
export function expandCommand(body: string, args: string): string {
  const parts = args.trim() ? args.trim().split(/\s+/) : [];
  return body
    .replace(/\$ARGUMENTS\b/g, args.trim())
    .replace(/\$(\d+)/g, (_m, n: string) => parts[Number(n) - 1] ?? "");
}
