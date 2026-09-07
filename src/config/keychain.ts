import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { KeychainPort } from "./credential.js";

// S6 系统钥匙串:把 API key 存进 macOS Keychain / Linux libsecret,避免明文落盘。
// account 形如 "dao/<profile>",一个 profile 一条;无 account 兜底旧的 "dao"(向后兼容 key_store)。
const exec = promisify(execFile);
const SERVICE = "dao-api-key";
const ACCOUNT = "dao";
// 钥匙串 CLI 调用超时:macOS 上 ad-hoc 重签名(bundle:install 每次 `codesign --sign -`)会改变
// 二进制的身份标识,系统可能弹"是否允许 dao 访问钥匙串"授权对话框——若无人应答,execFile 子进程
// 会挂住不退出,resolveCredential() 在渲染欢迎屏之前同步 await 它,导致整个启动/取号卡死且
// 终端上无任何提示。加超时兜底:超时后走既有 catch 分支,优雅降级为"未取到"而不是永久挂起。
const KEYCHAIN_TIMEOUT_MS = 8000;

// profiles 路径:平台支持即可用,除非 DAO_USE_KEYCHAIN=0/off 显式关闭(keychain 优先,文件兜底)。
export function keychainAvailable(): boolean {
  const off = process.env.DAO_USE_KEYCHAIN === "0" || process.env.DAO_USE_KEYCHAIN === "off";
  return !off && (process.platform === "darwin" || process.platform === "linux");
}

export async function keychainGet(account = ACCOUNT): Promise<string | undefined> {
  try {
    if (process.platform === "darwin") {
      const { stdout } = await exec("security", ["find-generic-password", "-a", account, "-s", SERVICE, "-w"], { timeout: KEYCHAIN_TIMEOUT_MS });
      return stdout.trim() || undefined;
    }
    if (process.platform === "linux") {
      const { stdout } = await exec("secret-tool", ["lookup", "service", SERVICE, "account", account], { timeout: KEYCHAIN_TIMEOUT_MS });
      return stdout.trim() || undefined;
    }
  } catch { /* 未存 / 无 binary / 被拒 */ }
  return undefined;
}

export async function keychainSet(key: string, account = ACCOUNT): Promise<boolean> {
  try {
    if (process.platform === "darwin") {
      await exec("security", ["add-generic-password", "-a", account, "-s", SERVICE, "-w", key, "-U"], { timeout: KEYCHAIN_TIMEOUT_MS });
      return true;
    }
    if (process.platform === "linux") {
      await new Promise<void>((resolve, reject) => {
        const c = execFile("secret-tool", ["store", "--label=dao api key", "service", SERVICE, "account", account], { timeout: KEYCHAIN_TIMEOUT_MS }, (e) => (e ? reject(e) : resolve()));
        c.stdin?.end(key); // secret-tool 从 stdin 读密钥(不进 argv/ps)
      });
      return true;
    }
  } catch { /* 无 binary / 被拒 */ }
  return false;
}

export async function keychainDelete(account = ACCOUNT): Promise<void> {
  try {
    if (process.platform === "darwin") await exec("security", ["delete-generic-password", "-a", account, "-s", SERVICE], { timeout: KEYCHAIN_TIMEOUT_MS });
    else if (process.platform === "linux") await exec("secret-tool", ["clear", "service", SERVICE, "account", account], { timeout: KEYCHAIN_TIMEOUT_MS });
  } catch { /* 本就没有 */ }
}

// 注入给 credential.ts/auth_wizard.ts 的运行时端口(每 account 一条)。
export const runtimeKeychain: KeychainPort = {
  get: (account) => keychainGet(account),
  set: (account, key) => keychainSet(key, account),
  delete: (account) => keychainDelete(account),
};

// 不可用时的空端口:get 永远 undefined、set 永远失败 → 自动回落到文件存储。
export const noopKeychain: KeychainPort = {
  get: async () => undefined,
  set: async () => false,
  delete: async () => {},
};
