import { readFileSync } from "node:fs";
import { exec } from "node:child_process";
import { matchesIfClause } from "../permissions/engine.js";

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

export interface SelectCtx { toolName?: string; argsJson?: string; source?: string }

// 选中本事件下匹配的 hook:matcher(工具事件按工具名 / SessionStart 按来源)+ if 预过滤。
export function selectHooks(specs: HookSpec[], event: string, ctx: SelectCtx): HookSpec[] {
  return specs.filter((s) => {
    if (s.event !== event) return false;
    if (s.matcher) {
      const target = event === "SessionStart" ? ctx.source : ctx.toolName;
      if (!target || !new RegExp(s.matcher).test(target)) return false;
    }
    if (s.if && ctx.toolName) {
      if (!matchesIfClause(s.if, ctx.toolName, ctx.argsJson ?? "{}")) return false;
    }
    return true;
  });
}

function runCommandHook(spec: HookSpec, cwd: string, payload: unknown, baseEnv: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const env: Record<string, string> = { ...baseEnv };
    if (spec.pluginRoot) { env.CLAUDE_PLUGIN_ROOT = spec.pluginRoot; env.DAO_PLUGIN_ROOT = spec.pluginRoot; }
    const child = exec(spec.command!, { cwd, timeout: spec.timeout ?? 30000, env: { ...process.env, ...env }, maxBuffer: 4 * 1024 * 1024 },
      (err: { code?: number } | null, stdout, stderr) => {
        const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
        resolve({ code, out: String(stdout), err: String(stderr) });
      });
    child.stdin?.on("error", () => {});
    try { child.stdin?.end(JSON.stringify(payload ?? {})); } catch { /* 无 stdin 也无妨 */ }
  });
}

const STRONGER: Record<string, number> = { allow: 0, ask: 1, deny: 2 };

export interface RunCtx { cwd: string; toolName?: string; argsJson?: string; source?: string; payload?: unknown }

// 跑某事件的全部选中 hook(P1 只执行 command 类型),合成 HookOutcome。
export async function runHooks(specs: HookSpec[], event: string, ctx: RunCtx): Promise<HookOutcome> {
  const sel = selectHooks(specs, event, { toolName: ctx.toolName, argsJson: ctx.argsJson, source: ctx.source });
  const outcome: HookOutcome = { block: false, reason: "", additionalContext: "" };
  const reasons: string[] = []; const ctxs: string[] = [];
  for (const s of sel) {
    if (s.type !== "command" || !s.command) continue; // 其余类型 P3 补
    const baseEnv: Record<string, string> = { DAO_HOOK_EVENT: event, CLAUDE_PROJECT_DIR: ctx.cwd };
    if (ctx.toolName) baseEnv.DAO_TOOL_NAME = ctx.toolName;
    const r = await runCommandHook(s, ctx.cwd, ctx.payload, baseEnv);
    const p = parseHookOutput(r.out, r.err, r.code);
    if (p.block) { outcome.block = true; if (p.reason) reasons.push(p.reason); }
    if (p.additionalContext) ctxs.push(p.additionalContext);
    if (p.permissionDecision && (outcome.permissionDecision === undefined || STRONGER[p.permissionDecision] > STRONGER[outcome.permissionDecision])) outcome.permissionDecision = p.permissionDecision;
    if (p.updatedInput) outcome.updatedInput = p.updatedInput;
  }
  outcome.reason = reasons.join("\n");
  outcome.additionalContext = ctxs.join("\n");
  return outcome;
}
