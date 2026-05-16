import { promises as fs } from "node:fs";
import path from "node:path";

// 读取 always 放行表(工具名集合);文件缺失或损坏→空集。
export async function loadAlwaysApproved(file: string): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

// 把一个工具名追加进 always 放行表(已存在则不重复)。
export async function appendAlwaysApproved(file: string, toolName: string): Promise<void> {
  const current = await loadAlwaysApproved(file);
  if (current.has(toolName)) return;
  current.add(toolName);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify([...current], null, 2), "utf8");
}
