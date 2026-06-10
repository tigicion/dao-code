import { promises as fs } from "node:fs";
import { exec } from "node:child_process";

// 生命周期钩子(对标 CC):在关键点跑用户配置的命令,用于校验/注入上下文/阻断/审计/格式化。
// 配置:.codeds/hooks.json(+ 用户 ~/.codeds/hooks.json)。形如:
// { "PreToolUse": [{ "matcher": "write_file|edit_file", "command": "..." }],
//   "PostToolUse": [...], "UserPromptSubmit": [...], "SessionStart": [...], "SessionEnd": [...] }
// 命令收到 JSON payload(stdin)+ 环境变量(DAO_HOOK_EVENT / DAO_TOOL_NAME);
// 对可阻断事件(PreToolUse/UserPromptSubmit),命令非 0 退出 = 阻断,其输出作为原因。

export interface HookEntry {
  matcher?: string; // 工具名正则(PreToolUse/PostToolUse 用);省略=匹配全部
  command: string;
}
export type HookConfig = Record<string, HookEntry[]>;

export async function loadHooks(files: string[]): Promise<HookConfig> {
  const merged: HookConfig = {};
  for (const f of files) {
    try {
      const cfg = JSON.parse(await fs.readFile(f, "utf8")) as HookConfig;
      for (const [ev, entries] of Object.entries(cfg)) {
        if (Array.isArray(entries)) (merged[ev] ??= []).push(...entries);
      }
    } catch {
      /* 文件不存在/非法 JSON → 跳过 */
    }
  }
  return merged;
}

function runOne(command: string, cwd: string, payload: unknown, env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = exec(
      command,
      { cwd, timeout: 30000, env: { ...process.env, ...env }, maxBuffer: 4 * 1024 * 1024 },
      (err: { code?: number } | null, stdout, stderr) => {
        const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
        resolve({ code, out: (String(stdout) + String(stderr)).trim() });
      },
    );
    // 命令可能不读 stdin 就退出 → 写入触发异步 EPIPE;监听 error 忽略之,避免未处理错误。
    child.stdin?.on("error", () => {});
    try {
      child.stdin?.end(JSON.stringify(payload ?? {}));
    } catch {
      /* 无 stdin 也无妨 */
    }
  });
}

export interface HookResult {
  block: boolean; // 是否阻断(可阻断事件:某命令非 0 退出)
  reason: string; // 阻断原因(阻断命令的输出)
  context: string; // 成功命令的 stdout(可注入上下文)
}

export async function runHooks(
  cfg: HookConfig,
  event: string,
  opts: { cwd: string; toolName?: string; payload?: unknown },
): Promise<HookResult> {
  const entries = (cfg[event] ?? []).filter(
    (e) => !e.matcher || (opts.toolName ? new RegExp(e.matcher).test(opts.toolName) : false),
  );
  let block = false;
  const reasons: string[] = [];
  const ctxs: string[] = [];
  for (const e of entries) {
    const env: Record<string, string> = { DAO_HOOK_EVENT: event };
    if (opts.toolName) env.DAO_TOOL_NAME = opts.toolName;
    const r = await runOne(e.command, opts.cwd, opts.payload, env);
    if (r.code !== 0) {
      block = true;
      if (r.out) reasons.push(r.out);
    } else if (r.out) {
      ctxs.push(r.out);
    }
  }
  return { block, reason: reasons.join("\n"), context: ctxs.join("\n") };
}
