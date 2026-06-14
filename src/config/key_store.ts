import { promises as fs } from "node:fs";
import path from "node:path";
import { keychainEnabled, keychainGet, keychainSet, keychainDelete } from "./keychain.js";

// 从钥匙串(若启用)或 ~/.dao/config.json 读已保存的 apiKey;缺失/损坏 → undefined。
export async function loadStoredKey(file: string): Promise<string | undefined> {
  if (keychainEnabled()) {
    const k = await keychainGet(); // S6:优先系统钥匙串
    if (k) return k;
  }
  try {
    const obj = JSON.parse(await fs.readFile(file, "utf8"));
    return obj && typeof obj.apiKey === "string" && obj.apiKey ? obj.apiKey : undefined;
  } catch {
    return undefined;
  }
}

// 保存 apiKey(合并已有内容),建目录,尽量设 600 权限。
// 清除已保存的 apiKey(/logout 用):保留 config 其它字段,只删 apiKey。
// 只从明文文件移除 apiKey(保留其它字段),不动钥匙串。
async function removeKeyFromFile(file: string): Promise<void> {
  try {
    const obj = JSON.parse(await fs.readFile(file, "utf8"));
    if (obj && typeof obj === "object") {
      delete obj.apiKey;
      await fs.writeFile(file, JSON.stringify(obj, null, 2), "utf8");
    }
  } catch {
    // 无文件/损坏 → 视为已清除
  }
}

export async function clearKey(file: string): Promise<void> {
  if (keychainEnabled()) await keychainDelete(); // S6:同时清钥匙串
  await removeKeyFromFile(file);
}

export async function saveKey(file: string, apiKey: string): Promise<void> {
  if (keychainEnabled() && (await keychainSet(apiKey))) {
    await removeKeyFromFile(file); // S6:存进钥匙串成功 → 从明文文件移除 apiKey(迁移),但不删钥匙串
    return;
  }
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
