// 快速验证 v2(修复 v1 重放方法的缺陷):v1 截断在"▶ Design and implement run_tasks"这条
// TodoWrite 已经标记"进行中"之后,模型看到这个状态直接判断"已经决定要做的事,执行就好",
// reasoning 长度只有 26-38 字符,几乎不推演,导致所有候选(包括直接点名 TaskGroup 的候选C)
// 都测不出差异——不是候选没用,是这个截断点本身让模型跳过了推演。
//
// v2 改截断点到 messages[0:12](通过 msg11 "asyncio OK"确认环境,TodoWrite 还没标记
// "设计实现"这一步为进行中),诊断确认:这个点上 reasoning 长度回升到 494-1255 字符,且
// 5/5 样本推演中都提到了 TaskGroup(用户建议:检查候选是否事前主动检查标准库,而不是事后
// 反悔型——事前检查这次真的进入了推演)。这一轮的输出是 TodoWrite,再往后一轮才是真正的
// Write——本脚本做两轮继续:第一轮拿到 TodoWrite 后模拟工具结果,第二轮才是要判定的
// run.py 实现选择。
//
// 跑法: DEEPSEEK_API_KEY=... VERIFY_N=8 npx tsx scripts/verify-cancel-async-tasks-taskgroup-replay-v2.ts
import { promises as fs } from "node:fs";
import { streamChat } from "../src/client/client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { execShellTool } from "../src/tools/exec_shell.js";
import { todoWriteTool } from "../src/tools/todo_write.js";
import { readFileTool } from "../src/tools/read_file.js";
import { writeFileTool } from "../src/tools/write_file.js";
import { verifyDoneTool } from "../src/tools/verify.js";
import type { AssistantMessage, ChatMessage, ToolCall } from "../src/client/types.js";

const apiKey = process.env.DEEPSEEK_API_KEY ?? "";
const baseUrl = "https://api.deepseek.com";
const model = "deepseek-v4-pro";
if (!apiKey) { console.error("需要 DEEPSEEK_API_KEY。"); process.exit(1); }

const full = JSON.parse(await fs.readFile("/tmp/cat_full_state.json", "utf8")) as { messages: ChatMessage[] };
const baseMessages: ChatMessage[] = full.messages.slice(0, 12);

const ANCHOR_A = "\"This library isn't installed, let me pip/apt install it\" → prefer implementing it with what's already available (standard library, a tool you've already confirmed works in this session) over installing something new — it cuts download time, trial-and-error, and migration cost.\n";
const BULLET_A = "  - \"Actually, let me just write my own version\" → if you just told yourself a specific standard-library construct fits this exact problem better, that's the answer — write with it. Don't slide back to a hand-rolled version because you'd already started reasoning through one; the construct being better-suited doesn't stop being true just because you're mid-thought on something else. If you can't name a concrete reason it doesn't fit (a real version/environment constraint), there isn't one.\n";

const ANCHOR_D = "- Don't add unrequested features, don't casually refactor, don't do \"while I'm here\" improvements. Fixing a bug doesn't need cleaning surrounding code; a simple feature doesn't need extra configurability.\n";
const BULLET_D = "- Before implementing a non-trivial piece of behavior yourself — concurrency/cancellation, retry/backoff, caching, connection pooling, parsing a well-known format, and similar well-trodden patterns — actively check whether the standard library or an already-available tool already provides it, rather than defaulting straight to a hand-rolled version. This check has to be a deliberate step you take, not something you rely on occurring to you mid-implementation: by the time you're already writing your own version, you're unlikely to stop and reconsider.\n";

function patch(messages: ChatMessage[], anchor: string, bullet: string, label: string): ChatMessage[] {
  const sys = messages[0]!;
  if (sys.role !== "system") throw new Error("messages[0] 不是 system");
  if (!sys.content.includes(anchor)) throw new Error(`${label} 锚点没找到`);
  return [{ ...sys, content: sys.content.replace(anchor, anchor + bullet) }, ...messages.slice(1)];
}

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const t of [execShellTool, todoWriteTool, readFileTool, writeFileTool, verifyDoneTool]) registry.register(t);
  return registry;
}

async function requestOnce(msgs: ChatMessage[]): Promise<AssistantMessage> {
  const tools = buildRegistry().toApiTools(undefined, "en");
  const gen = streamChat({
    baseUrl, apiKey, provider: "deepseek", model, messages: msgs,
    tools, parallelToolCalls: true,
    extra: { reasoning_effort: "high" },
  });
  let result: IteratorResult<unknown, AssistantMessage>;
  while (!(result = await gen.next()).done) { /* drain */ }
  return result.value;
}

// 第一轮(TodoWrite)之后,喂一个通用的工具结果(不针对具体候选,只是让对话能继续),再让
// 模型走第二轮,判定第二轮的 Write 内容。
function mockToolResult(tc: ToolCall): ChatMessage {
  if (tc.function.name === "TodoWrite") {
    return { role: "tool", tool_call_id: tc.id, content: "☑ Check Python version and asyncio availability\n▶ Design and implement run_tasks in /app/run.py\n☐ Verify the module can be imported and basic functionality works\n☐ Write a quick smoke test simulating cancellation" };
  }
  return { role: "tool", tool_call_id: tc.id, content: "[ok]" };
}

async function runTwoTurns(msgs: ChatMessage[]): Promise<AssistantMessage> {
  const turn1 = await requestOnce(msgs);
  const withAssistant1: ChatMessage[] = [...msgs, { role: "assistant", content: turn1.content ?? "", tool_calls: turn1.tool_calls, reasoningContent: turn1.reasoningContent }];
  const withToolResults: ChatMessage[] = [...withAssistant1, ...(turn1.tool_calls ?? []).map(mockToolResult)];
  // 如果第一轮已经直接是 Write(没有先走 TodoWrite),第二轮就不需要,直接返回 turn1
  if ((turn1.tool_calls ?? []).some((t) => t.function.name === "Write")) return turn1;
  return requestOnce(withToolResults);
}

function judge(tc: ToolCall[] | undefined): string {
  const writeCall = (tc ?? []).find((t) => t.function.name === "Write");
  if (!writeCall) {
    const names = (tc ?? []).map((t) => t.function.name);
    return `❓ 没有Write(${names.join(",") || "无工具调用"})`;
  }
  const args = writeCall.function.arguments;
  if (/TaskGroup/.test(args)) return `✅ 用了 TaskGroup: ${args.slice(0, 100)}`;
  if (/gather/.test(args)) return `❌ 手写 gather 方案: ${args.slice(0, 100)}`;
  return `🟡 看不出方案: ${args.slice(0, 100)}`;
}

async function runVariant(label: string, msgs: ChatMessage[], n: number) {
  console.error(`\n[verify] ${label}: ${n} 个样本…`);
  let good = 0;
  for (let i = 1; i <= n; i++) {
    const final = await runTwoTurns(msgs);
    const verdict = judge(final.tool_calls);
    console.log(`  样本${i}: ${verdict}`);
    if (verdict.startsWith("✅")) good++;
  }
  console.log(`  ${label} 命中率(用了TaskGroup): ${good}/${n}`);
  return good;
}

const n = Number(process.env.VERIFY_N) || 8;
const baseline = await runVariant("①baseline", baseMessages, n);
const candA = await runVariant("②候选A(事后不反悔型)", patch(baseMessages, ANCHOR_A, BULLET_A, "A"), n);
const candD = await runVariant("③候选D(事前主动检查型)", patch(baseMessages, ANCHOR_D, BULLET_D, "D"), n);
console.log(`\n=== 汇总(v2,修复截断点后) ===\n①baseline: ${baseline}/${n}\n②候选A: ${candA}/${n}\n③候选D: ${candD}/${n}`);
