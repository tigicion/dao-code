// 快速验证第4轮:largest-eigenval 同一卡点(messages[0..29],t≈841s dgeev全尺寸benchmark
// 结果刚出现)。前3轮(2版Tier1文字放在Action Discipline节 + 1版Tier2机制注入)均0效果。
// 本轮测试两个性质不同、此前未测过的候选,均来自和用户讨论后的新方向:
//
// 候选4a(工程克制重新定性):不放在Action Discipline(跟"要不要现在写"的执行时机规则
// 挤在一起),改放进"Engineering Restraint"节——这节开篇本来就承诺"正确的复杂度=任务
// 实际需要的,不多不少...这条管'别过度修饰'",但现有5条细则全是"别加没要求的功能/抽象/
// 兜底",没有一条覆盖"已达标但还想要更大优势"这个具体模式。新候选把"追求超出及格线的
// 优势"直接定性为过度修饰(违反工程克制),而不是"该不该写"(违反行动纪律)——用模型对
// 过度工程已有的负面直觉,不是跟它对精益求精的正面直觉对着干。
//
// 候选4b(剩余时间可见性):不讲道理,纯粹注入一条事实性的剩余时间信号("[系统:本次任务
// 预计仅剩约60秒]"),不叠加任何指令。背景:核实过 harbor_dao_agent.py 从未传 maxTurns,
// loop.ts 也没有任何面向模型的wall-clock剩余时间提示——模型在评测里完全不知道自己会被
// 900秒硬超时杀死,真实trial在t=841s时其实只剩54秒。测试"仅仅让模型知道时间快到了"这一
// 个变量本身有没有用,不叠加任何"该怎么做"的指令。
//
// 跑法: VOLCENGINE_API_KEY=... npx tsx scripts/verify-largest-eigenval-round4-replay.ts
import { promises as fs } from "node:fs";
import { streamChat } from "../src/client/client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { readFileTool } from "../src/tools/read_file.js";
import { listDirTool } from "../src/tools/list_dir.js";
import { writeFileTool } from "../src/tools/write_file.js";
import { editFileTool } from "../src/tools/edit_file.js";
import { multiEditTool } from "../src/tools/multi_edit.js";
import { execShellTool } from "../src/tools/exec_shell.js";
import { grepFilesTool } from "../src/tools/grep_files.js";
import { fileSearchTool } from "../src/tools/file_search.js";
import { todoWriteTool } from "../src/tools/todo_write.js";
import type { ChatMessage, ToolCall } from "../src/client/types.js";

const apiKey = process.env.VOLCENGINE_API_KEY ?? "";
const baseUrl = "https://ark.cn-beijing.volces.com/api/coding/v3";
const model = "deepseek-v4-pro";
if (!apiKey) { console.error("需要 VOLCENGINE_API_KEY。"); process.exit(1); }

const STATE_PATH =
  "/Users/huaruoxu/ClaudeProject/dao-code/evals/terminal-bench/jobs/largest-eigenval/" +
  "iter-largest-eigenval-0721/largest-eigenval__AG6qGT7/agent/dao_snapshot/.dao/sessions/" +
  "20260720-204000-ig72/state.json";

const state = JSON.parse(await fs.readFile(STATE_PATH, "utf8")) as { messages: ChatMessage[] };
const baseMessages: ChatMessage[] = state.messages.slice(0, 30);
const originalSystemPrompt = baseMessages[0].content as string;

// ---- 候选4a:Engineering Restraint 重新定性 ----
const ANCHOR_4A =
  "- Don't leave backward-compatibility hacks: don't rename unused _var, don't re-export deleted types, don't add // removed comments. If it's confirmed unused, just delete it.\n" +
  "- Don't delete other people's existing comments unless you're also deleting the code they describe, or you know for certain they're wrong — a comment that looks meaningless to you may encode a constraint or lesson invisible in the current diff.\n";
if (!originalSystemPrompt.includes(ANCHOR_4A)) { console.error("[verify] 4a锚点未命中"); process.exit(1); }
const INSERTION_4A =
  "- When the task states a concrete, checkable bar for success (a threshold to beat, a test to pass, \"faster/smaller/more accurate than X\"), meeting that bar literally IS the correct complexity — chasing a bigger margin than what's asked is itself a form of over-engineering, not diligence. Your own sense that the result could be more impressive doesn't lower a bar-meeting result's status below \"done\". Save the passing version to the deliverable first; only then, with budget to spare, treat further improvement as a separate optional pass on top of what's already secured — never instead of securing it.\n";
const candidate4a = originalSystemPrompt.replace(ANCHOR_4A, ANCHOR_4A + INSERTION_4A);

// ---- 候选4b:剩余时间可见性(纯事实,不含指令) ----
const TIME_SIGNAL_MSG: ChatMessage = {
  role: "system",
  content: "[系统:本次任务的时间预算约为900秒,当前已用时约841秒,预计仅剩约60秒。]",
};
const messages4b: ChatMessage[] = [...baseMessages, TIME_SIGNAL_MSG];

const registry = new ToolRegistry();
for (const t of [
  readFileTool, listDirTool, writeFileTool, editFileTool, multiEditTool,
  execShellTool, grepFilesTool, fileSearchTool, todoWriteTool,
]) registry.register(t);
const tools = registry.toApiTools(undefined, "en");

async function complete(msgs: ChatMessage[]) {
  const gen = streamChat({ baseUrl, apiKey, provider: "volcengine", model, messages: msgs, tools });
  let result;
  while (true) {
    const { value, done } = await gen.next();
    if (done) { result = value; break; }
  }
  return result;
}

function findsWriteToEigen(tc: ToolCall[] | undefined): ToolCall | undefined {
  return (tc ?? []).find((t) => t.function.name === "Write" && /eigen\.py/.test(t.function.arguments));
}

async function runSamples(label: string, messages: ChatMessage[], n: number) {
  console.error(`\n[verify] ${label}: ${n} 个样本…`);
  let hits = 0;
  for (let i = 0; i < n; i++) {
    const msgs = [...messages];
    const result = await complete(msgs);
    const wrote = findsWriteToEigen(result.tool_calls);
    const otherTools = (result.tool_calls ?? []).map((t) => t.function.name).join(",") || "(无工具调用)";
    console.log(`  样本${i + 1}: ${wrote ? "✅ 写了 eigen.py" : `❌ 未写 (${otherTools})`}`);
    const reasoning = (result as unknown as { reasoningContent?: string }).reasoningContent;
    if (reasoning) console.log(`    reasoning节选(前500字):\n${reasoning.slice(0, 500)}\n`);
    if (wrote) hits++;
  }
  console.log(`  ${label} 命中率: ${hits}/${n}`);
  return hits;
}

const n = Number(process.env.VERIFY_N) || 3;
const hits4a = await runSamples("候选4a(工程克制重新定性)", [{ ...baseMessages[0], content: candidate4a }, ...baseMessages.slice(1)], n);
const hits4b = await runSamples("候选4b(剩余时间可见性)", messages4b, n);

console.log(`\n=== 第4轮结果 ===\n候选4a: ${hits4a}/${n}\n候选4b: ${hits4b}/${n}`);
