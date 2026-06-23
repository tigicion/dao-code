# P1 · Hook 引擎核心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 把 `src/hooks/hooks.ts` 重写为 CC 兼容的 hook 引擎(CC 嵌套配置 + JSON 输出协议 + matcher/if + 环境变量 + command 类型 + 多 hook 合成),并把 SessionStart additionalContext 注入、PreToolUse 的 permissionDecision/updatedInput 接进 DAO,使 superpowers bootstrap 跑通、skill 纪律修复。

**Architecture:** 引擎拆成可单测的纯函数(`parseHookOutput`/`loadHooks`/`selectHooks`)+ 编排 `runHooks` 返回 `HookOutcome`。调用点(index.ts/execute.ts)消费 outcome:注入上下文(SessionStart 一次进前缀、其余追加尾部)、裁决权限、改写入参。

**Tech Stack:** TypeScript ESM(`.js` import 后缀)、Node `child_process`/`fs`、Vitest。单测 `npx vitest run <file>`;全量 `npm test`;`npm run typecheck`;`npm run lint`(0 error)。

参见 spec:`docs/design/specs/2026-06-17-hook-cc-parity-design.md`

---

## File Structure
| 文件 | 职责 | 改动 |
|---|---|---|
| `src/hooks/hooks.ts` | 引擎:类型 + loadHooks + selectHooks + parseHookOutput + runHooks | 重写 |
| `src/hooks/hooks.test.ts` | 引擎单测 | 重写 |
| `src/permissions/engine.ts` | 暴露一个 `matchesIfClause(ifPattern, toolName, argsJson)` 供 `if` 复用 | 加导出 |
| `src/tools/types.ts` | `ToolContext.preToolHook` 返回类型扩展为 HookOutcome 子集 | 改类型 |
| `src/tools/execute.ts` | preToolHook 的 permissionDecision/updatedInput 接裁决与执行 | 改 |
| `src/index.ts` | loadHooks 传 pluginRoot;SessionStart 注入(post-resume);UserPromptSubmit/PreToolUse 消费 outcome | 改 |

---

## Task 1: 引擎类型 + `parseHookOutput`(输出协议,纯函数)

**Files:** Modify `src/hooks/hooks.ts`(先加类型与该函数,旧 runHooks 暂留);Test `src/hooks/hooks.test.ts`

- [ ] **Step 1: 写失败测试** — 新建/重写 `src/hooks/hooks.test.ts` 顶部加:

```ts
import { describe, it, expect } from "vitest";
import { parseHookOutput } from "./hooks.js";

describe("parseHookOutput", () => {
  it("exit 2 → 阻断,stderr 作原因", () => {
    expect(parseHookOutput("", "blocked!", 2)).toMatchObject({ block: true, reason: "blocked!" });
  });
  it("CC JSON hookSpecificOutput.additionalContext → 注入文本", () => {
    const out = parseHookOutput(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "HELLO" } }), "", 0);
    expect(out.additionalContext).toBe("HELLO");
  });
  it("顶层 additionalContext / additional_context 兜底", () => {
    expect(parseHookOutput(JSON.stringify({ additionalContext: "A" }), "", 0).additionalContext).toBe("A");
    expect(parseHookOutput(JSON.stringify({ additional_context: "B" }), "", 0).additionalContext).toBe("B");
  });
  it("permissionDecision / updatedInput 解析", () => {
    const out = parseHookOutput(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", updatedInput: { command: "ls" } } }), "", 0);
    expect(out.permissionDecision).toBe("deny");
    expect(out.updatedInput).toEqual({ command: "ls" });
  });
  it("非 JSON 的纯 stdout → 当 additionalContext", () => {
    expect(parseHookOutput("plain text", "", 0).additionalContext).toBe("plain text");
  });
});
```

- [ ] **Step 2: 跑确认失败** — `npx vitest run src/hooks/hooks.test.ts`(parseHookOutput 未导出)。

- [ ] **Step 3: 实现** — 在 `src/hooks/hooks.ts` 顶部(保留现有 import)加类型 + 函数:

```ts
export type HookType = "command" | "prompt" | "agent" | "http" | "callback" | "function";

export interface HookSpec {
  event: string;
  matcher?: string;            // 正则串:工具事件匹配工具名;SessionStart 匹配来源
  if?: string;                 // 权限规则式预过滤,如 "Bash(git push *)"
  type: HookType;
  command?: string;            // command 类型
  url?: string;                // http 类型(P3)
  prompt?: string;             // prompt 类型(P3)
  callbackId?: string;         // callback/function(P3)
  async?: boolean;
  timeout?: number;            // ms
  pluginRoot?: string;         // ${CLAUDE_PLUGIN_ROOT}
}

export interface HookOutcome {
  block: boolean;
  reason: string;                                 // 阻断原因
  additionalContext: string;                      // 注入文本(多 hook 拼接)
  permissionDecision?: "allow" | "ask" | "deny";  // 多 hook 合成 deny>ask>allow
  updatedInput?: Record<string, unknown>;         // 后写覆盖
}

// 解析单个 hook 的输出(exit code + stdout JSON/纯文本)。
export function parseHookOutput(stdout: string, stderr: string, code: number): Partial<HookOutcome> {
  if (code === 2) return { block: true, reason: (stderr || stdout).trim() };
  if (code !== 0) return {}; // 非阻断错误(stderr 仅给用户,这里不消费)
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
    return { additionalContext: s }; // 非 JSON → 纯文本当上下文(兼容简单 hook)
  }
}
```

- [ ] **Step 4: 跑确认通过** — `npx vitest run src/hooks/hooks.test.ts`(5 用例)· `npm run typecheck`。

- [ ] **Step 5: 提交**
```bash
git add src/hooks/hooks.ts src/hooks/hooks.test.ts
git commit -m "feat(hooks): HookSpec/HookOutcome 类型 + parseHookOutput 输出协议解析"
```

---

## Task 2: `loadHooks` — CC 嵌套格式解析 + 规范化

**Files:** Modify `src/hooks/hooks.ts`(替换旧 loadHooks);Test 追加。

- [ ] **Step 1: 写失败测试** — 追加到 `hooks.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadHooks } from "./hooks.js";

describe("loadHooks (CC 嵌套格式)", () => {
  it("解外层 {hooks} + 嵌套 hooks[],规范化为 HookSpec[],带 pluginRoot", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hk-"));
    const f = path.join(dir, "hooks.json");
    writeFileSync(f, JSON.stringify({ hooks: { SessionStart: [
      { matcher: "startup|clear", hooks: [{ type: "command", command: "echo hi", timeout: 5000 }] },
    ] } }));
    const specs = loadHooks([{ path: f, pluginRoot: "/PLUGIN" }]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ event: "SessionStart", matcher: "startup|clear", type: "command", command: "echo hi", timeout: 5000, pluginRoot: "/PLUGIN" });
  });
  it("裸 {event:[...]} 也接受(无外层 hooks 包)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hk-"));
    const f = path.join(dir, "h2.json");
    writeFileSync(f, JSON.stringify({ PreToolUse: [{ matcher: "write_file", hooks: [{ type: "command", command: "x", if: "Write(*.ts)" }] }] }));
    const specs = loadHooks([{ path: f }]);
    expect(specs[0]).toMatchObject({ event: "PreToolUse", matcher: "write_file", if: "Write(*.ts)", type: "command", command: "x" });
  });
  it("坏文件跳过", () => {
    expect(loadHooks([{ path: "/no/such/file.json" }])).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑确认失败** — loadHooks 签名变了(现在收 `{path, pluginRoot?}[]`)。

- [ ] **Step 3: 实现** — 替换 `src/hooks/hooks.ts` 里旧的 `loadHooks`(及旧 `HookEntry`/`HookConfig` 类型)为:

```ts
import { readFileSync } from "node:fs";

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
        const ifClause = typeof g.if === "string" ? g.if : undefined;
        const inner = Array.isArray(g.hooks) ? (g.hooks as Record<string, unknown>[]) : [g];
        for (const hk of inner) {
          const type = (hk.type as HookType) ?? "command";
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
```
> 删除旧的 `loadHooks`(async fs 版)、`HookConfig`/`HookEntry` 接口、旧 `HookResult`(被 HookOutcome 取代)。旧 `runOne` 暂留(Task 4 用)。

- [ ] **Step 4: 跑确认通过 + typecheck**(此时旧 runHooks 可能因类型变化报错——Task 4 会重写它;若 typecheck 报 runHooks 相关错,本 Task 暂时把旧 runHooks 整体注释/删除,Task 4 补回)。

- [ ] **Step 5: 提交**
```bash
git add src/hooks/hooks.ts src/hooks/hooks.test.ts
git commit -m "feat(hooks): loadHooks 改 CC 嵌套格式 + 规范化 HookSpec[](弃旧扁平格式)"
```

---

## Task 3: `selectHooks` — matcher(工具名/来源)+ `if` 预过滤

**Files:** Modify `src/hooks/hooks.ts`、`src/permissions/engine.ts`;Test 追加。

- [ ] **Step 1: 暴露 if 匹配器** — 读 `src/permissions/engine.ts` 与 `src/permissions/identity.ts`,确认 `toCcIdentity(toolName, argsJson)` 产出 CC 身份串、`rules.ts` 有规则匹配。在 `src/permissions/engine.ts` 末尾加纯函数(复用现有 identity/rules;若已有等价匹配器,直接转调):

```ts
import { toCcIdentity } from "./identity.js";
import { ruleMatchesIdentity } from "./rules.js"; // 若名称不同,改成 rules.ts 实际导出的匹配函数

// `if` 预过滤:CC 规则式(如 "Bash(git push *)")是否匹配此工具调用。
export function matchesIfClause(ifPattern: string, toolName: string, argsJson: string): boolean {
  const id = toCcIdentity(toolName, argsJson);
  if (!id) return false;
  return ruleMatchesIdentity(ifPattern, id);
}
```
> 读 `rules.ts`:找到"判断一个规则模式是否匹配某 CallIdentity"的现有函数,转调它。若 rules.ts 的匹配是基于规则数组,临时构造单元素数组调用即可。把实际用到的函数名替换进来。

- [ ] **Step 2: 写失败测试** — 追加到 `hooks.test.ts`:

```ts
import { selectHooks } from "./hooks.js";

const spec = (o: Partial<import("./hooks.js").HookSpec>): import("./hooks.js").HookSpec =>
  ({ event: "X", type: "command", command: "c", ...o } as import("./hooks.js").HookSpec);

describe("selectHooks", () => {
  it("工具事件:matcher 匹配工具名", () => {
    const specs = [spec({ event: "PreToolUse", matcher: "write_file|edit_file" }), spec({ event: "PreToolUse", matcher: "exec_shell" })];
    const sel = selectHooks(specs, "PreToolUse", { toolName: "write_file", argsJson: "{}" });
    expect(sel).toHaveLength(1);
  });
  it("SessionStart:matcher 匹配来源", () => {
    const specs = [spec({ event: "SessionStart", matcher: "startup|clear" }), spec({ event: "SessionStart", matcher: "resume" })];
    expect(selectHooks(specs, "SessionStart", { source: "startup" })).toHaveLength(1);
  });
  it("无 matcher → 全选", () => {
    expect(selectHooks([spec({ event: "SessionStart" })], "SessionStart", { source: "resume" })).toHaveLength(1);
  });
});
```

- [ ] **Step 3: 实现 selectHooks** — 在 `hooks.ts` 加:

```ts
import { matchesIfClause } from "../permissions/engine.js";

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
```

- [ ] **Step 4: 跑确认通过 + typecheck** — `npx vitest run src/hooks/hooks.test.ts src/permissions/engine.test.ts`。

- [ ] **Step 5: 提交**
```bash
git add src/hooks/hooks.ts src/permissions/engine.ts src/hooks/hooks.test.ts
git commit -m "feat(hooks): selectHooks——matcher(工具名/SessionStart来源)+ if 复用权限规则匹配"
```

---

## Task 4: `runHooks` — 编排 command 执行 + 环境变量 + 多 hook 合成

**Files:** Modify `src/hooks/hooks.ts`;Test 追加。

- [ ] **Step 1: 写失败测试** — 追加:

```ts
import { runHooks } from "./hooks.js";

describe("runHooks (command + 合成)", () => {
  it("执行 command,解析 additionalContext,注入 CLAUDE_PLUGIN_ROOT", async () => {
    const specs = [spec({ event: "SessionStart", type: "command",
      command: `node -e 'process.stdout.write(JSON.stringify({hookSpecificOutput:{additionalContext:"ROOT="+process.env.CLAUDE_PLUGIN_ROOT}}))'`,
      pluginRoot: "/PR" })];
    const out = await runHooks(specs, "SessionStart", { cwd: process.cwd(), source: "startup" });
    expect(out.additionalContext).toContain("ROOT=/PR");
  });
  it("多 hook:permissionDecision 取 deny>ask>allow,context 拼接", async () => {
    const mk = (pd: string, ctx: string) => spec({ event: "PreToolUse", type: "command",
      command: `node -e 'process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:"${pd}",additionalContext:"${ctx}"}}))'` });
    const out = await runHooks([mk("allow", "a"), mk("deny", "b"), mk("ask", "c")], "PreToolUse", { cwd: process.cwd(), toolName: "x", argsJson: "{}" });
    expect(out.permissionDecision).toBe("deny");
    expect(out.additionalContext).toContain("a"); expect(out.additionalContext).toContain("b");
  });
  it("exit 2 → block", async () => {
    const out = await runHooks([spec({ event: "PreToolUse", type: "command", command: `node -e 'process.stderr.write("NO");process.exit(2)'` })], "PreToolUse", { cwd: process.cwd(), toolName: "x", argsJson: "{}" });
    expect(out.block).toBe(true); expect(out.reason).toContain("NO");
  });
});
```

- [ ] **Step 2: 跑确认失败**。

- [ ] **Step 3: 实现** — 替换 `hooks.ts` 里旧 `runHooks`(及旧 `runOne` 如仍在,改造为下面的 `runCommandHook`):

```ts
import { exec } from "node:child_process";

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
```
> 确保 `HookResult`(旧)所有引用已改为 `HookOutcome`。

- [ ] **Step 4: 跑确认通过 + 全量** — `npx vitest run src/hooks/hooks.test.ts` · `npm run typecheck`(index.ts/execute.ts 处 runHooks 调用此时签名变了,可能报错——Task 5/6 修;若本 Task 后全量编不过属预期,但本 Task 的单测要绿)。

- [ ] **Step 5: 提交**
```bash
git add src/hooks/hooks.ts src/hooks/hooks.test.ts
git commit -m "feat(hooks): runHooks 编排 command 执行 + env(CLAUDE_PLUGIN_ROOT)+ 多hook合成(deny>ask>allow)"
```

---

## Task 5: index.ts 接线 —— loadHooks pluginRoot + SessionStart 注入 + UserPromptSubmit 消费

**Files:** Modify `src/index.ts`、`src/skills/plugins.ts`(若 hookFiles 需带 root)。

- [ ] **Step 1: loadHooks 传 HookFileRef** — 读 `src/skills/plugins.ts` 的 `pluginComponentDirs`,确认 `hookFiles` 现为 `string[]`。改为提供每个插件 hook 文件的 `pluginRoot`(=该插件根目录);若改动面大,退而在 index.ts 用 `{ path, pluginRoot: path.dirname(path.dirname(p)) }` 推导(插件 hook 在 `<root>/hooks/hooks.json`)。把 `index.ts:550` 的 loadHooks 调用改为传 `HookFileRef[]`:

```ts
  const hooks = loadHooks([
    { path: path.join(os.homedir(), ".dao", "hooks.json") },
    ...pluginComp.hookFiles.map((p: string) => ({ path: p, pluginRoot: path.dirname(path.dirname(p)) })),
    ...(trustProject ? [{ path: path.join(workspaceRoot, ".dao", "hooks.json") }] : []),
  ]);
```
> `loadHooks` 现是同步函数(去掉 await)。

- [ ] **Step 2: PreToolUse/PostToolUse 调用更新** — `index.ts:557/561` 的 runHooks 调用改用新签名(`{cwd, toolName, argsJson, payload}`),preToolHook 现返回 HookOutcome 子集:

```ts
  ctx.preToolHook = async (toolName, argsJson) => {
    const o = await runHooks(hooks, "PreToolUse", { cwd: workspaceRoot, toolName, argsJson, payload: { tool: toolName, args: argsJson } });
    return { block: o.block, reason: o.reason, additionalContext: o.additionalContext, permissionDecision: o.permissionDecision, updatedInput: o.updatedInput };
  };
  ctx.postToolHook = async (toolName, argsJson, result) => {
    await runHooks(hooks, "PostToolUse", { cwd: workspaceRoot, toolName, argsJson, payload: { tool: toolName, args: argsJson, result } });
  };
```

- [ ] **Step 3: SessionStart 注入(post-resume,缓存安全)** — 删除 `index.ts:563` 处的 `await runHooks(hooks, "SessionStart", ...)`(它在 resume 前、且丢弃结果)。改为在**会话消息定稿后**(store/resume 块之后,约 `const store = createSessionStore(...)` 之后、首个回合之前)加:

```ts
      // SessionStart hook:把 additionalContext 一次性注入(紧随系统提示,整会话稳定 → 缓存安全)。
      const ssOutcome = await runHooks(hooks, "SessionStart", { cwd: workspaceRoot, source: continueFlag ? "resume" : "startup" });
      if (ssOutcome.additionalContext.trim()) {
        const sysIdx = session.messages[0]?.role === "system" ? 1 : 0;
        session.messages.splice(sysIdx, 0, { role: "system", content: ssOutcome.additionalContext });
      }
```
> 放在 resume 把 `session.messages` 替换之后,确保注入不被覆盖;在首个 runTurn 之前,确保进稳定前缀。

- [ ] **Step 4: UserPromptSubmit 消费** — `index.ts` 的 `const up = await runHooks(hooks, "UserPromptSubmit", ...)`:`up` 现是 HookOutcome。把注入行 `if (up.context) ...` 改为:

```ts
          if (up.additionalContext) session.messages.push({ role: "system", content: `[hook 注入的上下文]\n${up.additionalContext}` });
```
> `up.block` 的处理(`if (up.block) {...}`)保持不变(HookOutcome 仍有 block/reason)。

- [ ] **Step 5: SessionEnd** — `index.ts:1336` 的 `runHooks(hooks, "SessionEnd", {cwd})` 签名兼容(无 toolName/source),保持。

- [ ] **Step 6: typecheck + 全量** — `npm run typecheck` · `npm test`(既有 hooks 相关测试若引用旧 API 需更新)。

- [ ] **Step 7: 提交**
```bash
git add src/index.ts src/skills/plugins.ts
git commit -m "feat(hooks): index 接新引擎——SessionStart 注入(缓存安全)+ UserPromptSubmit/工具钩子消费 outcome"
```

---

## Task 6: execute.ts —— PreToolUse 的 permissionDecision + updatedInput

**Files:** Modify `src/tools/types.ts`、`src/tools/execute.ts`。

- [ ] **Step 1: 扩展 preToolHook 返回类型** — `src/tools/types.ts:67`:

```ts
  preToolHook?: (toolName: string, argsJson: string) => Promise<{
    block: boolean; reason: string;
    additionalContext?: string;
    permissionDecision?: "allow" | "ask" | "deny";
    updatedInput?: Record<string, unknown>;
  }>;
```

- [ ] **Step 2: dispatchOne 消费 updatedInput + additionalContext** — 在 `src/tools/execute.ts` 的 `dispatchOne`,把 preToolHook 调用段:

```ts
    if (ctx.preToolHook) {
      const h = await ctx.preToolHook(name, argsJson);
      if (h.block) { const c = `[被 hook 阻止] ${h.reason || "(无原因)"}`; audit(c); return { role: "tool", tool_call_id: tc.id, content: c }; }
    }
    const content = await registry.dispatch(name, argsJson, ctx);
```
改为(应用 updatedInput;additionalContext 追加到结果尾部供模型看到):

```ts
    let effectiveArgs = argsJson;
    let hookContext = "";
    if (ctx.preToolHook) {
      const h = await ctx.preToolHook(name, argsJson);
      if (h.block) { const c = `[被 hook 阻止] ${h.reason || "(无原因)"}`; audit(c); return { role: "tool", tool_call_id: tc.id, content: c }; }
      if (h.updatedInput) effectiveArgs = JSON.stringify(h.updatedInput); // hook 改写工具入参
      if (h.additionalContext) hookContext = h.additionalContext;
    }
    let content = await registry.dispatch(name, effectiveArgs, ctx);
    if (hookContext) content = `${content}\n[hook 提示] ${hookContext}`;
```
> 注意:`content` 改为 `let`;下游 `audit(content)`/postToolHook 用最终 content。`postToolHook` 传 `effectiveArgs`。

- [ ] **Step 3: permissionDecision 接裁决** — 权限裁决在 `executeToolCalls` 的 `gate.decide`(execute.ts 第一循环)。PreToolUse 的 permissionDecision 应作"最后一公里":在 gate 决策后用 hook 的 decision 覆盖(deny 最强;allow 可降级为放行但敏感项仍 bypass-immune)。读 `executeToolCalls` 裁决循环,在 `gate.decide` 之后插入:对每个 tc 调一次 `ctx.preToolHook` 拿 permissionDecision——**但 preToolHook 已在 dispatchOne 调用**,为避免重复执行 hook,改为:**裁决阶段统一调 preToolHook 一次,缓存其 outcome 给该 tc**,dispatchOne 复用。
  实现:在 `executeToolCalls` 裁决前,为每个 tc 预跑 `const pre = ctx.preToolHook ? await ctx.preToolHook(name,args) : undefined`,据 `pre.permissionDecision` 调整 decision(deny→拒;allow→放行除非 sensitive;ask→转审批);把 `pre` 存进一个 `Map<id, outcome>`,dispatchOne 改为接收预跑结果而非自己再调 preToolHook(改 dispatchOne 签名加可选 `pre` 参数,有则用、无则自调)。
  > 这是本 Task 最复杂处:读 execute.ts 的 `executeToolCalls` 裁决循环与 `dispatchOne` 调用链,落实"preToolHook 每个工具调用只执行一次,其 block/permissionDecision 用于裁决、updatedInput/additionalContext 用于执行"。给出最小改动:裁决循环预跑并缓存 outcome→Map;dispatchOne 增参 `pre?: PreOutcome` 复用。

- [ ] **Step 4: typecheck + 全量** — `npm run typecheck` · `npm test`(execute.test.ts 不应回归:preToolHook 默认 undefined)。

- [ ] **Step 5: 提交**
```bash
git add src/tools/types.ts src/tools/execute.ts
git commit -m "feat(hooks): PreToolUse permissionDecision 接裁决 + updatedInput 改写工具入参(每工具只跑一次 hook)"
```

---

## Task 7: 集成验证 —— superpowers bootstrap 注入 + 缓存安全

**Files:** Create `src/hooks/integration.test.ts`。

- [ ] **Step 1: 写集成测试** — 用一个模拟 SessionStart hook(输出 CC JSON additionalContext)验证 loadHooks→runHooks 全链:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadHooks, runHooks } from "./hooks.js";

describe("hook 引擎集成:SessionStart additionalContext 注入", () => {
  it("CC 格式配置 + 脚本输出 hookSpecificOutput.additionalContext → outcome 带注入文本", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hk-int-"));
    const script = path.join(dir, "ss.js");
    writeFileSync(script, `process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:"<EXTREMELY_IMPORTANT>BOOTSTRAP</EXTREMELY_IMPORTANT>"}}))`);
    const cfg = path.join(dir, "hooks.json");
    writeFileSync(cfg, JSON.stringify({ hooks: { SessionStart: [
      { matcher: "startup|clear|compact", hooks: [{ type: "command", command: `node ${script}` }] },
    ] } }));
    const specs = loadHooks([{ path: cfg, pluginRoot: dir }]);
    const out = await runHooks(specs, "SessionStart", { cwd: dir, source: "startup" });
    expect(out.additionalContext).toContain("BOOTSTRAP");
    // 来源不匹配则不触发
    const none = await runHooks(specs, "SessionStart", { cwd: dir, source: "resume" });
    expect(none.additionalContext).toBe("");
  });
});
```

- [ ] **Step 2: 跑确认通过** — `npx vitest run src/hooks/integration.test.ts`。

- [ ] **Step 3: 全量回归** — `npm test` · `npm run typecheck` · `npm run lint`(0 error)。

- [ ] **Step 4: 提交**
```bash
git add src/hooks/integration.test.ts
git commit -m "test(hooks): SessionStart additionalContext 注入全链集成验证"
```

---

## Self-Review(已执行)
**Spec 覆盖(P1 部分):** CC 嵌套配置→T2;输出协议→T1;matcher/if→T3;runHooks/env/合成→T4;SessionStart 注入(缓存安全)→T5;UserPromptSubmit 消费→T5;permissionDecision/updatedInput→T6;集成→T7。`command` 类型→T4;其余 5 类型留 P3(spec 已声明)。
**占位符扫描:** T6 Step 3 的"读 execute.ts 落实预跑缓存"是本计划唯一未给逐行代码处——因 permissionDecision 接裁决需读 `executeToolCalls` 实际裁决链;已给出明确实现策略(裁决阶段预跑 preToolHook→Map,dispatchOne 增参复用)+ 不变式("每工具只跑一次 hook")。实现者须读该函数落地。其余步骤均有完整代码。
**类型一致性:** `HookSpec`/`HookOutcome`/`HookFileRef`/`parseHookOutput`/`loadHooks`/`selectHooks`/`runHooks`/`matchesIfClause` 跨任务一致;preToolHook 返回类型在 T6 扩展、T5 已按扩展后形态返回。
**已知前置:** T3 依赖 rules.ts 的实际匹配函数名(实现者读 `src/permissions/rules.ts` 替换 `ruleMatchesIdentity`);T5 依赖 plugins.ts 的 hookFiles 形态(给了 dirname 推导兜底)。
