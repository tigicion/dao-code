import { execFile } from "node:child_process";
import { promisify } from "node:util";

// S6 系统钥匙串:把 API key 存进 macOS Keychain / Linux libsecret,避免明文落盘。
// 显式开关 DAO_USE_KEYCHAIN=1 启用(默认仍走明文文件,保持既有行为/可测)。
const exec = promisify(execFile);
const SERVICE = "dao-api-key";
const ACCOUNT = "dao";

export function keychainEnabled(): boolean {
  return process.env.DAO_USE_KEYCHAIN === "1" && (process.platform === "darwin" || process.platform === "linux");
}

export async function keychainGet(): Promise<string | undefined> {
  try {
    if (process.platform === "darwin") {
      const { stdout } = await exec("security", ["find-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w"]);
      return stdout.trim() || undefined;
    }
    if (process.platform === "linux") {
      const { stdout } = await exec("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT]);
      return stdout.trim() || undefined;
    }
  } catch { /* 未存 / 无 binary / 被拒 */ }
  return undefined;
}

export async function keychainSet(key: string): Promise<boolean> {
  try {
    if (process.platform === "darwin") {
      await exec("security", ["add-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w", key, "-U"]);
      return true;
    }
    if (process.platform === "linux") {
      await new Promise<void>((resolve, reject) => {
        const c = execFile("secret-tool", ["store", "--label=dao api key", "service", SERVICE, "account", ACCOUNT], (e) => (e ? reject(e) : resolve()));
        c.stdin?.end(key); // secret-tool 从 stdin 读密钥(不进 argv/ps)
      });
      return true;
    }
  } catch { /* 无 binary / 被拒 */ }
  return false;
}

export async function keychainDelete(): Promise<void> {
  try {
    if (process.platform === "darwin") await exec("security", ["delete-generic-password", "-a", ACCOUNT, "-s", SERVICE]);
    else if (process.platform === "linux") await exec("secret-tool", ["clear", "service", SERVICE, "account", ACCOUNT]);
  } catch { /* 本就没有 */ }
}
