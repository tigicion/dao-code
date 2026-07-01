import type { ToolCall, ToolMessage } from "../client/types.js";
import type { Capability, ToolContext } from "./types.js";
import type { ToolRegistry } from "./registry.js";
import type { ApprovalGate, ApprovalRequest } from "../approval/types.js";
import { isSensitiveCall, isDangerousCall } from "../permissions/engine.js";
import { auditDecision } from "../permissions/audit.js";
import { rememberRule } from "../permissions/identity.js";
import { getLang } from "../i18n/i18n.js";

// 给审批/展示用的人类可读摘要:命令保留【真实换行】(而非原始 JSON 的字面 \n),路径类只显路径。
export function describeCall(name: string, argsJson: string): string {
  let a: Record<string, unknown> = {};
  try { a = JSON.parse(argsJson) as Record<string, unknown>; } catch { return `${name} ${argsJson.slice(0, 200)}`; }
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const en = getLang() === "en";
  switch (name) {
    case "exec_shell": return `$ ${s(a.command) || name}`;
    case "write_file": return en ? `Write ${s(a.path)}` : `写入 ${s(a.path)}`;
    case "edit_file": case "multi_edit": return en ? `Edit ${s(a.path)}` : `编辑 ${s(a.path)}`;
    case "notebook_edit": return en ? `Edit notebook ${s(a.path)}` : `编辑笔记本 ${s(a.path)}`;
    case "fetch_url": return en ? `Fetch ${s(a.url)}` : `抓取 ${s(a.url)}`;
    case "web_search": return en ? `Search ${s(a.query)}` : `搜索 ${s(a.query)}`;
    default: {
      const v = s(a.path) || s(a.command) || s(a.url) || s(a.query);
      return v ? `${name} ${v}` : name;
    }
  }
}

// 并发安全(对标 CC 的 isConcurrencySafe):只读/网络/plan 类不改工作区文件、无副作用顺序问题 → 可并行;
// write/exec 改文件或有外部副作用 → 作"屏障":独占执行,不与任何工具并发(防 race / 不确定状态)。
const SAFE_CAPS = new Set<Capability>(["read", "network", "plan"]);
const MAX_CONCURRENCY = 8; // 安全工具批的并发上限,避免一口气打满 fd / 连接

// 工具结果是否表示失败(非零退出/超时/中断/Error)——用于错误级联、审计 ok 判定、反思层失败信号。
export const looksFailed = (content: string): boolean =>
  content.startsWith("Error") || /\[exit ([1-9]\d*)\]|\[超时|\[已中断\]/.test(content);

// PreToolUse 钩子产物(== ctx.preToolHook 的返回);executeToolCalls 在裁决阶段每工具只跑一次,
// 缓存后透传给 dispatchOne 复用(绝不二次执行 hook 命令)。
type PreHookOutcome = Awaited<ReturnType<NonNullable<ToolContext["preToolHook"]>>>;

// PreToolUse 钩子改写后的最终入参(updatedInput 已 apply);effectiveArgs 是唯一真相:
// 既用于裁决(gate.decide/敏感检测),也用于派发/审计/PostToolUse——杜绝"按旧参裁决、按新参执行"。
function applyUpdatedInput(argsJson: string, outcome: PreHookOutcome | undefined): string {
  return outcome?.updatedInput ? JSON.stringify(outcome.updatedInput) : argsJson;
}

async function dispatchOne(
  tc: ToolCall,
  registry: ToolRegistry,
  ctx: ToolContext,
  preOutcome?: PreHookOutcome, // 裁决阶段已跑过的 hook 结果;给了就复用,不再调 preToolHook
  effectiveArgs?: string, // 裁决阶段已 apply updatedInput 的最终入参;给了就用,不在此重复改写
): Promise<ToolMessage> {
  const name = tc.function.name;
  const cap = registry.get(name)?.capability ?? "unknown";
  const startMs = Date.now();
  // PreToolUse 钩子:优先用裁决阶段缓存的结果;无缓存(其他调用路径)才自行跑一次。
  const argsJson = tc.function.arguments;
  const h = preOutcome ?? (ctx.preToolHook ? await ctx.preToolHook(name, argsJson) : undefined);
  // 最终入参:裁决阶段已算好就直接用(单一真相);否则在此 apply(其他调用路径的兜底)。
  const finalArgs = effectiveArgs ?? applyUpdatedInput(argsJson, h);
  const audit = (content: string) => {
    const ok = !looksFailed(content) && !content.includes("被 hook 阻止");
    ctx.toolAudit?.call(name, cap, ok, Date.now() - startMs, finalArgs);
  };
  try {
    if (h?.block) { const c = `[被 hook 阻止] ${h.reason || "(无原因)"}`; audit(c); return { role: "tool", tool_call_id: tc.id, content: c }; }
    let content = await registry.dispatch(name, finalArgs, ctx);
    if (h?.additionalContext) content = `${content}\n[hook 提示] ${h.additionalContext}`; // 附到工具结果让模型看见
    if (ctx.postToolHook) await ctx.postToolHook(name, finalArgs, content); // PostToolUse(副作用,如自动格式化)
    audit(content);
    return { role: "tool", tool_call_id: tc.id, content };
  } catch (err) {
    const errMsg = `Error: ${(err as Error).message}`;
    audit(errMsg);
    return { role: "tool", tool_call_id: tc.id, content: errMsg };
  }
}

const rejectMsg = (tc: ToolCall, content: string): ToolMessage => ({
  role: "tool",
  tool_call_id: tc.id,
  content,
});

// 权限感知 + 并发安全地执行一批 tool_call:
// - 裁决:allow 待运行 / deny 直接拦截回灌 / ask 合并审批后定夺
// - 执行:安全工具(read/network/plan)成批并行(限 MAX_CONCURRENCY);write/exec 作屏障独占运行
// - 结果按原顺序返回
export async function executeToolCalls(
  toolCalls: ToolCall[],
  registry: ToolRegistry,
  ctx: ToolContext,
  gate: ApprovalGate,
): Promise<ToolMessage[]> {
  // 0. PreToolUse 钩子:每工具只跑一次,缓存结果(裁决阶段 block/permissionDecision 与派发阶段
  //    updatedInput/additionalContext 共用同一次执行,绝不重复跑 hook 命令)。
  // 安全不变量:hook 的 updatedInput 改写后的【最终入参】是裁决与派发的唯一真相——
  // 先 apply 再 gate.decide/敏感检测,杜绝"按原参放行、按改写参(可能 rm -rf)执行"的绕过。
  const preHooks = new Map<string, PreHookOutcome>();
  const effArgs = new Map<string, string>(); // tc.id → updatedInput apply 后的最终入参
  for (const tc of toolCalls) {
    const outcome = ctx.preToolHook ? await ctx.preToolHook(tc.function.name, tc.function.arguments) : undefined;
    if (outcome) preHooks.set(tc.id, outcome);
    effArgs.set(tc.id, applyUpdatedInput(tc.function.arguments, outcome));
  }

  // 1. 逐次裁决:产出"待运行"集合与即时拒绝消息。
  const gatedRequests: ApprovalRequest[] = [];
  const results = new Map<string, ToolMessage>();
  const toRun = new Set<string>();
  for (const tc of toolCalls) {
    const tool = registry.get(tc.function.name);
    const args = effArgs.get(tc.id)!; // 最终入参(已 apply updatedInput);裁决一律基于它
    let decision = tool ? gate.decide(tc.function.name, args, tool) : "allow";
    const cap0 = tool?.capability ?? "unknown";
    // PreToolUse 钩子的"最后一公里"裁决覆盖规则判定:
    // block/deny 最强(直接拒);ask 强制人工审批;allow 仅在非敏感/非危险时把 ask 降为放行,绝不覆盖规则 deny。
    const hook = preHooks.get(tc.id);
    if (hook?.block || hook?.permissionDecision === "deny") decision = "deny";
    else if (hook?.permissionDecision === "ask" && decision !== "deny") decision = "ask";
    else if (hook?.permissionDecision === "allow" && decision === "ask") {
      const risky = isSensitiveCall(tc.function.name, args) || isDangerousCall(tc.function.name, args);
      if (!risky) decision = "allow";
    }
    if (decision === "allow") { toRun.add(tc.id); ctx.permAudit?.decided(tc.function.name, cap0, "allow", "rule"); }
    else if (decision === "deny") {
      const reason = hook?.block || hook?.permissionDecision === "deny"
        ? `[被 hook 阻止] ${hook.reason || "权限被 hook 拒绝(deny)。"}`
        : "该操作被权限规则拒绝(deny)。如需放行,请在 .dao/settings.json 调整 permissions。";
      results.set(tc.id, rejectMsg(tc, reason)); ctx.permAudit?.decided(tc.function.name, cap0, "deny", "rule");
    }
    else {
      // sensitive=true 既抑制"始终允许",又让 auto 模式跳过分类器直接走人工(敏感目标/危险命令)。
      const sensitive = isSensitiveCall(tc.function.name, args) || isDangerousCall(tc.function.name, args);
      gatedRequests.push({
        id: tc.id, toolName: tc.function.name, capability: tool!.capability,
        summary: describeCall(tc.function.name, args), argsJson: args,
        sensitive,
        noPersist: !sensitive && rememberRule(tc.function.name, args) === null, // 记不成规则 → 不提供"始终允许"
      });
    }
  }

  // 2. ask 工具合并审批
  const approvals =
    gatedRequests.length > 0 ? await gate.requestBatch(gatedRequests) : new Map<string, boolean>();
  for (const r of gatedRequests) {
    const tc = toolCalls.find((t) => t.id === r.id)!;
    const capA = registry.get(tc.function.name)?.capability ?? "unknown";
    if (approvals.get(tc.id)) { toRun.add(tc.id); ctx.permAudit?.decided(tc.function.name, capA, "ask-approved", "ask"); }
    // 走到这里的拒绝都是人工审批里用户选了"否"(auto 模式不再自动拒绝,拿不准的会转人工)。
    else { results.set(tc.id, rejectMsg(tc, "用户拒绝执行该工具。")); ctx.permAudit?.decided(tc.function.name, capA, "ask-denied", "ask"); }
  }

  // S3.3 审计:记录写/执行/网络类工具的最终裁决(放行/拒绝)到 .dao/audit.log。
  const auditIso = new Date().toISOString();
  for (const tc of toolCalls) {
    const cap = registry.get(tc.function.name)?.capability;
    if (cap === "write" || cap === "exec" || cap === "network") {
      auditDecision(ctx.workspaceRoot, auditIso, {
        tool: tc.function.name, capability: cap,
        decision: toRun.has(tc.id) ? "allow" : "deny",
        summary: describeCall(tc.function.name, effArgs.get(tc.id)!), // 审计记最终入参的摘要
      });
    }
  }

  // 3. 按 capability 并发安全执行:安全工具积成一批并行(限并发);遇到 write/exec 先 flush 再独占运行(屏障)。
  const isSafe = (tc: ToolCall) => {
    const cap = registry.get(tc.function.name)?.capability;
    return cap !== undefined && SAFE_CAPS.has(cap);
  };
  let barrierAborted = false;
  let batch: ToolCall[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const group = batch;
    batch = [];
    let i = 0;
    const worker = async () => {
      while (i < group.length) {
        const tc = group[i++]!;
        results.set(tc.id, await dispatchOne(tc, registry, ctx, preHooks.get(tc.id), effArgs.get(tc.id)));
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, group.length) }, worker));
  };
  for (const tc of toolCalls) {
    if (!toRun.has(tc.id)) continue; // deny / 被拒的已有结果
    if (isSafe(tc)) batch.push(tc);
    else {
      await flush(); // 屏障:先跑完已积累的安全批
      // ③ 错误级联:本批里前一个 exec_shell 已失败 → 跳过后续 exec/write,
      // 防"npm install 挂了还接着 npm run build"这类连锁错误(对标 CC Bash 级联)。
      if (barrierAborted) {
        results.set(tc.id, { role: "tool", tool_call_id: tc.id, content: "已跳过:本批前一个命令失败,为避免连锁错误未执行。请先处理上一个错误再重试。" });
        continue;
      }
      const r = await dispatchOne(tc, registry, ctx, preHooks.get(tc.id), effArgs.get(tc.id)); // 独占运行 write/exec
      results.set(tc.id, r);
      if (registry.get(tc.function.name)?.capability === "exec" && looksFailed(r.content)) barrierAborted = true;
    }
  }
  await flush();

  // 4. 按原顺序收集。兜底:即便某调用意外没产出结果(如中断),也补一条 tool 结果——
  // 保证"每个 tool_call 都有对应 tool 消息",绝不向上返回缺口(下一轮会 DeepSeek 400)。
  return toolCalls.map(
    (tc) => results.get(tc.id) ?? { role: "tool", tool_call_id: tc.id, content: "工具未产生结果(可能被中断)。" },
  );
}
