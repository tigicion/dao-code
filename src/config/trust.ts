import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// S/P2-37 目录信任:项目级 .dao/settings.json 与 hooks.json 会被加载、且 hooks 会在事件时执行命令。
// 进入一个未信任目录(如刚 clone 的仓库)时【默认不加载这些项目配置】,避免恶意仓库自动执行命令;
// 用户显式 `dao trust`(或 DAO_TRUST=1)信任后才加载。安全默认 + 显式 opt-in,不在启动期弹交互(避免 readline/Ink 冲突)。
const trustFile = path.join(os.homedir(), ".dao", "trusted.json");

// 该目录是否含"会被自动加载/执行"的项目级配置——没有就无需信任(免打扰)。
export function hasProjectConfig(root: string): boolean {
  return ["settings.json", "settings.local.json", "hooks.json"].some((f) => existsSync(path.join(root, ".dao", f)));
}

export async function isTrusted(root: string): Promise<boolean> {
  try {
    const arr = JSON.parse(await fs.readFile(trustFile, "utf8"));
    return Array.isArray(arr) && arr.includes(root);
  } catch {
    return false;
  }
}

export async function addTrusted(root: string): Promise<void> {
  let arr: string[] = [];
  try { const j = JSON.parse(await fs.readFile(trustFile, "utf8")); if (Array.isArray(j)) arr = j; } catch { /* 新建 */ }
  if (!arr.includes(root)) arr.push(root);
  await fs.mkdir(path.dirname(trustFile), { recursive: true });
  await fs.writeFile(trustFile, JSON.stringify(arr, null, 2), "utf8");
}

// 综合判定:是否应加载此目录的项目级配置。
export async function shouldTrustProject(root: string): Promise<boolean> {
  if (process.env.DAO_TRUST === "1") return true;
  if (!hasProjectConfig(root)) return true; // 无项目配置 → 无所谓信任
  return isTrusted(root);
}
