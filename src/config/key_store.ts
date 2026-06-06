import { promises as fs } from "node:fs";
import path from "node:path";

// 从 ~/.codeds/config.json 读已保存的 apiKey;缺失/损坏 → undefined。
export async function loadStoredKey(file: string): Promise<string | undefined> {
  try {
    const obj = JSON.parse(await fs.readFile(file, "utf8"));
    return obj && typeof obj.apiKey === "string" && obj.apiKey ? obj.apiKey : undefined;
  } catch {
    return undefined;
  }
}

// 保存 apiKey(合并已有内容),建目录,尽量设 600 权限。
export async function saveKey(file: string, apiKey: string): Promise<void> {
  let obj: Record<string, unknown> = {};
  try {
    obj = JSON.parse(await fs.readFile(file, "utf8"));
    if (typeof obj !== "object" || obj === null) obj = {};
  } catch {
    obj = {};
  }
  obj.apiKey = apiKey;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(obj, null, 2), "utf8");
  try {
    await fs.chmod(file, 0o600);
  } catch {
    // 权限设不上不致命(如某些文件系统)
  }
}
