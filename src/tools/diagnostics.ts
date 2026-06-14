import { exec as _exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
const exec = promisify(_exec);

// 用户未设 DAO_DIAGNOSTICS_CMD 时,自动嗅探一个合理的诊断命令。
// 优先 ESLint(配置存在且装了 .bin/eslint),其次 tsconfig + .bin/tsc;都没有则不跑。
// 纯函数 + 不抛(existsSync 不抛,join 不抛)。
export function detectDiagnosticsCmd(workspaceRoot: string): string | undefined {
  const has = (...p: string[]) => existsSync(join(workspaceRoot, ...p));

  const eslintConfigs = [
    ".eslintrc",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.json",
    ".eslintrc.yaml",
    ".eslintrc.yml",
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    "eslint.config.ts",
  ];
  if (eslintConfigs.some((c) => has(c)) && has("node_modules", ".bin", "eslint")) {
    return "npx eslint .";
  }

  if (has("tsconfig.json") && has("node_modules", ".bin", "tsc")) {
    return "npx tsc --noEmit";
  }

  return undefined;
}

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
