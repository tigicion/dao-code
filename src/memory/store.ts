import { promises as fs } from "node:fs";
import path from "node:path";
import type { Memory } from "./types.js";

// 读一个记忆文件(JSON 数组);缺失/损坏/非数组 → 空。
export async function loadMemoryFile(file: string): Promise<Memory[]> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((m) => m && typeof m.text === "string")
      .map((m) => ({ text: m.text as string }));
  } catch {
    return [];
  }
}

// 合并用户级 + 项目级(用户级在前)。
export async function loadAllMemories(
  projectFile: string,
  userFile: string,
): Promise<Memory[]> {
  const [u, p] = await Promise.all([loadMemoryFile(userFile), loadMemoryFile(projectFile)]);
  return [...u, ...p];
}

// 写入一条记忆,去重(同文件内 trim 后完全相同则跳过)。返回是否实际新增。
export async function addMemory(file: string, text: string): Promise<boolean> {
  const norm = text.trim();
  if (!norm) return false;
  const mems = await loadMemoryFile(file);
  if (mems.some((m) => m.text.trim() === norm)) return false;
  mems.push({ text: norm });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(mems, null, 2), "utf8");
  return true;
}
