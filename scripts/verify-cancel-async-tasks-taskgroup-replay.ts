// 快速验证(debug-evolve 第四步):候选——针对 cancel-async-tasks 退化的两个独立缺口分别设计
// 候选,truncate 真实 state.json 到"设计 run.py 实现"这一整轮开始之前(messages[0:14]),
// 让模型重新生成这一轮,判断最终写进 run.py 的实现是否用了 asyncio.TaskGroup。
//
// 真实卡点:cancel-async-tasks(pro+default赛道 2026-08-03,
// jobs-pro-default/fast8-2048mb-0803/cancel-async-tasks__yarFnww)。DAO 推演时明确说出
// "TaskGroup handles cancellation more cleanly",紧接着却说"Actually, let me just write
// a solid implementation"转向手写 asyncio.gather + except BaseException,这个手写版本在
// 真实 SIGINT(而非进程内 task.cancel())下无法保证已启动任务的 cleanup 代码执行,官方验收
// 失败。同一道题在主赛道(DS Pro,2026-07-16)用的是 asyncio.TaskGroup,通过。
//
// 内省(三层问答,Layer 0 盲答独立确认)定位到两个独立缺口:
// ①"已识别更优的标准库方案却没有采纳"——没有强制"识别到更优方案就必须追问为什么不用"这一步;
// ②"用比任务原文实际场景更弱的方式做验证"(进程内 task.cancel() vs 真实 SIGINT 子进程)。
//
// 本脚本对比三组:①baseline(不改系统提示词) ②候选A(仅加"标准库优先"条款,self-rationalization
// 清单) ③候选B(仅加"验证触发方式要对齐任务原文"条款,Verification Discipline 段落)。
//
// 跑法: DEEPSEEK_API_KEY=... VERIFY_N=8 npx tsx scripts/verify-cancel-async-tasks-taskgroup-replay.ts
import { promises as fs } from "node:fs";
import { streamChat } from "../src/client/client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { execShellTool } from "../src/tools/exec_shell.js";
import { todoWriteTool } from "../src/tools/todo_write.js";
import { readFileTool } from "../src/tools/read_file.js";
import { writeFileTool } from "../src/tools/write_file.js";
import { verifyDoneTool } from "../src/tools/verify.js";
import type { ChatMessage, ToolCall } from "../src/client/types.js";

const apiKey = process.env.DEEPSEEK_API_KEY ?? "";
const baseUrl = "https://api.deepseek.com";
const model = "deepseek-v4-pro";
if (!apiKey) { console.error("需要 DEEPSEEK_API_KEY。"); process.exit(1); }

const STATE_PATH = "/tmp/cat_trunc_state.json";
const state = JSON.parse(await fs.readFile(STATE_PATH, "utf8")) as { messages: ChatMessage[] };
const baseMessages: ChatMessage[] = state.messages; // 14条,截断在"设计并写 run.py"这一轮开始之前

const ANCHOR_A = "\"This library isn't installed, let me pip/apt install it\" → prefer implementing it with what's already available (standard library, a tool you've already confirmed works in this session) over installing something new — it cuts download time, trial-and-error, and migration cost.\n";
const BULLET_A = "  - \"Actually, let me just write my own version\" → if you just told yourself a specific standard-library construct fits this exact problem better, that's the answer — write with it. Don't slide back to a hand-rolled version because you'd already started reasoning through one; the construct being better-suited doesn't stop being true just because you're mid-thought on something else. If you can't name a concrete reason it doesn't fit (a real version/environment constraint), there isn't one.\n";

const ANCHOR_B = "- Coding / file changes → run tests, build, if needed actually run the program and observe behavior.\n";
const BULLET_B = "- If the task describes a specific triggering mechanism or scenario (\"via keyboard interrupt\", \"when the connection drops\", \"on restart\"), your verification must trigger it the same way — a real SIGINT to a real subprocess, not an in-process call that produces a similar-looking effect. A test that exercises a different code path than the one the task describes isn't verification of that scenario, however cleanly it passes.\n";

function patchA(messages: ChatMessage[]): ChatMessage[] {
  const sys = messages[0]!;
  if (sys.role !== "system") throw new Error("messages[0] 不是 system");
  if (!sys.content.includes(ANCHOR_A)) throw new Error("候选A锚点没找到");
  return [{ ...sys, content: sys.content.replace(ANCHOR_A, ANCHOR_A + BULLET_A) }, ...messages.slice(1)];
}
function patchB(messages: ChatMessage[]): ChatMessage[] {
  const sys = messages[0]!;
  if (sys.role !== "system") throw new Error("messages[0] 不是 system");
  if (!sys.content.includes(ANCHOR_B)) throw new Error("候选B锚点没找到");
  return [{ ...sys, content: sys.content.replace(ANCHOR_B, ANCHOR_B + BULLET_B) }, ...messages.slice(1)];
}

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const t of [execShellTool, todoWriteTool, readFileTool, writeFileTool, verifyDoneTool]) registry.register(t);
  return registry;
}

async function requestOnce(msgs: ChatMessage[]) {
  const tools = buildRegistry().toApiTools(undefined, "en");
  const gen = streamChat({
    baseUrl, apiKey, provider: "deepseek", model, messages: msgs,
    tools, parallelToolCalls: true,
    extra: { reasoning_effort: "high" },
  });
  let result;
  while (true) { const { value, done } = await gen.next(); if (done) { result = value; break; } }
  return result;
}

function judge(tc: ToolCall[] | undefined): string {
  const writeCall = (tc ?? []).find((t) => t.function.name === "Write");
  if (!writeCall) {
    const names = (tc ?? []).map((t) => t.function.name);
    return `❓ 这一轮没有Write(${names.join(",") || "无工具调用"})`;
  }
  const args = writeCall.function.arguments;
  if (/TaskGroup/.test(args)) return `✅ 用了 TaskGroup: ${args.slice(0, 120)}`;
  if (/gather/.test(args)) return `❌ 手写 gather 方案: ${args.slice(0, 120)}`;
  return `🟡 既没TaskGroup也没gather,看不出方案: ${args.slice(0, 120)}`;
}

async function runVariant(label: string, msgs: ChatMessage[], n: number) {
  console.error(`\n[verify] ${label}: ${n} 个样本…`);
  let good = 0;
  for (let i = 1; i <= n; i++) {
    const r = await requestOnce(msgs);
    const verdict = judge(r.tool_calls);
    console.log(`  样本${i}: ${verdict}`);
    if (verdict.startsWith("✅")) good++;
  }
  console.log(`  ${label} 命中率(用了TaskGroup): ${good}/${n}`);
  return good;
}

// 轮1(候选A/B)结果:baseline 0/8、候选A 0/8、候选B 0/8——三组样本里模型从未在这一轮
// Write 里出现过 TaskGroup,不只是"想到了又放弃",是这次重放大多数样本压根没把 TaskGroup
// 当成候选考虑过。轮2换一个更具体的候选C:直接点名"并发+取消+清理"这类场景优先用
// asyncio.TaskGroup,而不是笼统的"标准库优先"措辞——用来判断问题是不是"泛化提醒不够
// 具体,需要精确点名这个 API 才能触发"。
const ANCHOR_C = ANCHOR_A;
const BULLET_C = "  - When implementing concurrent async tasks that must be cancellable with guaranteed cleanup (e.g. \"cancel via keyboard interrupt but cleanup code should still run\"), asyncio.TaskGroup (3.11+) is built specifically for correct cancellation propagation and waiting for sibling cleanup — a hand-rolled asyncio.gather + except-and-recancel is a well-known place to get this subtly wrong under real OS signals. If TaskGroup is available in the target Python version, use it instead of reimplementing its semantics.\n";
function patchC(messages: ChatMessage[]): ChatMessage[] {
  const sys = messages[0]!;
  if (!sys.content.includes(ANCHOR_C)) throw new Error("候选C锚点没找到");
  return [{ ...sys, content: sys.content.replace(ANCHOR_C, ANCHOR_C + BULLET_C) }, ...messages.slice(1)];
}

// 轮3:用户指出候选A的措辞缺陷——"if you just told yourself X is better"是【事后反悔】型,
// 前提是模型已经自己想到了更优方案;真实重放里大多数样本压根没让 TaskGroup 进入候选集,
// 这种反悔条款自然不会触发。候选D改成【事前主动检查】型,放进 Engineering Restraint(比
// 手写实现更早的决策点),不依赖模型是否碰巧想到。
const ANCHOR_D = "- Don't add unrequested features, don't casually refactor, don't do \"while I'm here\" improvements. Fixing a bug doesn't need cleaning surrounding code; a simple feature doesn't need extra configurability.\n";
const BULLET_D = "- Before implementing a non-trivial piece of behavior yourself — concurrency/cancellation, retry/backoff, caching, connection pooling, parsing a well-known format, and similar well-trodden patterns — actively check whether the standard library or an already-available tool already provides it, rather than defaulting straight to a hand-rolled version. This check has to be a deliberate step you take, not something you rely on occurring to you mid-implementation: by the time you're already writing your own version, you're unlikely to stop and reconsider.\n";
function patchD(messages: ChatMessage[]): ChatMessage[] {
  const sys = messages[0]!;
  if (!sys.content.includes(ANCHOR_D)) throw new Error("候选D锚点没找到");
  return [{ ...sys, content: sys.content.replace(ANCHOR_D, ANCHOR_D + BULLET_D) }, ...messages.slice(1)];
}

const n = Number(process.env.VERIFY_N) || 8;
const candD = await runVariant("⑤候选D(事前主动检查stdlib,放Engineering Restraint)", patchD(baseMessages), n);
console.log(`\n=== 汇总(轮3) ===\n⑤候选D: ${candD}/${n}`);
