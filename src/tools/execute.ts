import type { ToolCall, ToolMessage } from "../client/types.js";
import type { Capability, ToolContext } from "./types.js";
import type { ToolRegistry } from "./registry.js";
import type { ApprovalGate, ApprovalRequest } from "../approval/types.js";
import { isSensitiveCall, isDangerousCall } from "../permissions/engine.js";
import { auditDecision } from "../permissions/audit.js";
import { rememberRule } from "../permissions/identity.js";

// 给审批/展示用的人类可读摘要:命令保留【真实换行】(而非原始 JSON 的字面 \n),路径类只显路径。
export function describeCall(name: string, argsJson: string): string {
  let a: Record<string, unknown> = {};
  try { a = JSON.parse(argsJson) as Record<string, unknown>; } catch { return `${name} ${argsJson.slice(0, 200)}`; }
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  switch (name) {
    case "exec_shell": return `$ ${s(a.command) || name}`;
    case "write_file": return `写入 ${s(a.path)}`;
    case "edit_file": case "multi_edit": return `编辑 ${s(a.path)}`;
    case "notebook_edit": return `编辑笔记本 ${s(a.path)}`;
    case "fetch_url": return `抓取 ${s(a.url)}`;
    case "web_search": return `搜索 ${s(a.query)}`;
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

// 工具结果是否表示失败(非零退出/超时/中断/Error)——用于错误级联与审计 ok 判定。
const looksFailed = (content: string): boolean =>
  content.startsWith("Error") || /\[exit ([1-9]\d*)\]|\[超时|\[已中断\]/.test(content);

async function dispatchOne(
  tc: ToolCall,
  registry: ToolRegistry,
  ctx: ToolContext,
): Promise<ToolMessage> {
  const name = tc.function.name;
  const argsJson = tc.function.arguments;
  const cap = registry.get(name)?.capability ?? "unknown";
  const startMs = Date.now();
  const audit = (content: string) => {
    const ok = !looksFailed(content) && !content.includes("被 hook 阻止");
    ctx.toolAudit?.call(name, cap, ok, Date.now() - startMs, argsJson);
  };
  try {
    // PreToolUse 钩子:命令阻断则不执行该工具,把原因作为结果回灌。
    if (ctx.preToolHook) {
      const h = await ctx.preToolHook(name, argsJson);
      if (h.block) { const c = `[被 hook 阻止] ${h.reason || "(无原因)"}`; audit(c); return { role: "tool", tool_call_id: tc.id, content: c }; }
    }
    const content = await registry.dispatch(name, argsJson, ctx);
    if (ctx.postToolHook) await ctx.postToolHook(name, argsJson, content); // PostToolUse(副作用,如自动格式化)
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
  // 1. 逐次裁决:产出"待运行"集合与即时拒绝消息。
  const gatedRequests: ApprovalRequest[] = [];
  const results = new Map<string, ToolMessage>();
  const toRun = new Set<string>();
  for (const tc of toolCalls) {
    const tool = registry.get(tc.function.name);
    const decision = tool ? gate.decide(tc.function.name, tc.function.arguments, tool) : "allow";
    const cap0 = tool?.capability ?? "unknown";
    if (decision === "allow") { toRun.add(tc.id); ctx.permAudit?.decided(tc.function.name, cap0, "allow", "rule"); }
    else if (decision === "deny") { results.set(tc.id, rejectMsg(tc, "该操作被权限规则拒绝(deny)。如需放行,请在 .dao/settings.json 调整 permissions。")); ctx.permAudit?.decided(tc.function.name, cap0, "deny", "rule"); }
    else {
      // sensitive=true 既抑制"始终允许",又让 auto 模式跳过分类器直接走人工(敏感目标/危险命令)。
      const sensitive = isSensitiveCall(tc.function.name, tc.function.arguments) || isDangerousCall(tc.function.name, tc.function.arguments);
      gatedRequests.push({
        id: tc.id, toolName: tc.function.name, capability: tool!.capability,
        summary: describeCall(tc.function.name, tc.function.arguments), argsJson: tc.function.arguments,
        sensitive,
        noPersist: !sensitive && rememberRule(tc.function.name, tc.function.arguments) === null, // 记不成规则 → 不提供"始终允许"
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
        summary: describeCall(tc.function.name, tc.function.arguments),
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
        results.set(tc.id, await dispatchOne(tc, registry, ctx));
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
      const r = await dispatchOne(tc, registry, ctx); // 独占运行 write/exec
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
