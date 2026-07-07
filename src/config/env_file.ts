import { promises as fs } from "node:fs";

// 解析 .env 文本:KEY=VALUE 一行一条,跳过空行/#注释,去掉值两侧引号。纯函数。
export function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

// 读取并解析 .env 文件;缺失/读不了 → 空。
export async function loadDotenv(file: string): Promise<Record<string, string>> {
  try {
    return parseDotenv(await fs.readFile(file, "utf8"));
  } catch {
    return {};
  }
}

// 把 .env 里的键补进 process.env——仅当该键尚未在环境中设置(真实 env 变量优先,不被 .env 覆盖)。
// 返回实际被补入的键名。缺失文件 → 不做事、返回 []。
export async function applyDotenv(file: string): Promise<string[]> {
  const parsed = await loadDotenv(file);
  const applied: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
      applied.push(k);
    }
  }
  return applied;
}
