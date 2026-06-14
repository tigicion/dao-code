import { exec as _exec } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(_exec);

// P2-11 轻量 LSP 替代:编辑后跑用户配置的诊断命令(DAO_DIAGNOSTICS_CMD,如 "tsc --noEmit" / "eslint .")
// 把编译/类型/lint 错误回灌给模型,让它当轮自查自改——无需上 LSP 协议。
// 有输出(报错)才回灌;干净时返回 undefined,不打扰。
export async function runDiagnosticsCmd(cmd: string, cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await exec(cmd, { cwd, timeout: 60000, maxBuffer: 4 * 1024 * 1024, signal });
    const out = `${stdout}${stderr}`.trim();
    return out ? out.slice(0, 4000) : undefined; // 退出 0 但有输出(警告)也回灌
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
    return out ? out.slice(0, 4000) : err.message ? `诊断命令执行失败:${err.message}` : undefined;
  }
}
