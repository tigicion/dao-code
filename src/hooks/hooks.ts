import { readFileSync } from "node:fs";
import { exec } from "node:child_process";

export type HookType = "command" | "prompt" | "agent" | "http" | "callback" | "function";

export interface HookSpec {
  event: string;
  matcher?: string;
  if?: string;
  type: HookType;
  command?: string;
  url?: string;
  prompt?: string;
  callbackId?: string;
  async?: boolean;
  timeout?: number;
  pluginRoot?: string;
}

export interface HookOutcome {
  block: boolean;
  reason: string;
  additionalContext: string;
  permissionDecision?: "allow" | "ask" | "deny";
  updatedInput?: Record<string, unknown>;
}

// Parse one hook's output (exit code + stdout JSON/plain text).
export function parseHookOutput(stdout: string, stderr: string, code: number): Partial<HookOutcome> {
  if (code === 2) return { block: true, reason: (stderr || stdout).trim() };
  if (code !== 0) return {};
  const s = stdout.trim();
  if (!s) return {};
  try {
    const j = JSON.parse(s) as Record<string, unknown>;
    const hso = (j.hookSpecificOutput ?? {}) as Record<string, unknown>;
    const ctx = (hso.additionalContext ?? j.additionalContext ?? j.additional_context) as string | undefined;
    const pd = hso.permissionDecision as HookOutcome["permissionDecision"] | undefined;
    const ui = (hso.updatedInput ?? j.updatedInput) as Record<string, unknown> | undefined;
    const o: Partial<HookOutcome> = {};
    if (typeof ctx === "string") o.additionalContext = ctx;
    if (pd === "allow" || pd === "ask" || pd === "deny") o.permissionDecision = pd;
    if (ui && typeof ui === "object") o.updatedInput = ui;
    return o;
  } catch {
    return { additionalContext: s };
  }
}

export interface HookFileRef { path: string; pluginRoot?: string }

// 读 CC 格式 hook 配置文件,规范化为 HookSpec[]。解外层 {"hooks":{}} 包;裸 {event:[]} 也接受。
export function loadHooks(refs: HookFileRef[]): HookSpec[] {
  const specs: HookSpec[] = [];
  for (const ref of refs) {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(ref.path, "utf8")); } catch { continue; }
    if (!raw || typeof raw !== "object") continue;
    const root = raw as Record<string, unknown>;
    const events = (root.hooks && typeof root.hooks === "object" ? root.hooks : root) as Record<string, unknown>;
    for (const [event, groups] of Object.entries(events)) {
      if (!Array.isArray(groups)) continue;
      for (const g of groups as Record<string, unknown>[]) {
        const matcher = typeof g.matcher === "string" ? g.matcher : undefined;
        const groupIf = typeof g.if === "string" ? g.if : undefined;
        const inner = Array.isArray(g.hooks) ? (g.hooks as Record<string, unknown>[]) : [g];
        for (const hk of inner) {
          const type = (hk.type as HookType) ?? "command";
          const ifClause = typeof hk.if === "string" ? hk.if : groupIf;
          specs.push({
            event, matcher, if: ifClause, type,
            ...(typeof hk.command === "string" ? { command: hk.command } : {}),
            ...(typeof hk.url === "string" ? { url: hk.url } : {}),
            ...(typeof hk.prompt === "string" ? { prompt: hk.prompt } : {}),
            ...(typeof hk.async === "boolean" ? { async: hk.async } : {}),
            ...(typeof hk.timeout === "number" ? { timeout: hk.timeout } : {}),
            ...(ref.pluginRoot ? { pluginRoot: ref.pluginRoot } : {}),
          });
        }
      }
    }
  }
  return specs;
}

// NOTE: Old runOne / HookResult / runHooks commented out — Task 4 rewrites them with new HookSpec-based signature.
// They referenced the removed HookConfig/HookEntry types and would not compile.
/*
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
      // 无 stdin 也无妨
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
*/
