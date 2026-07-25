// 快速验证(Tier 2候选):largest-eigenval 同一个卡点(messages[0..29],t≈841s dgeev全尺寸
// benchmark结果刚出现),这次不改 system_prompt.ts 文字,而是模拟"如果 loop.ts 里已有的
// noProgress 进度提醒机制(ADVISE_EVERY=5)在这道题的真实评测里被启用会怎样"。
//
// 背景:真实harbor评测从未传 --progress-advice(src/index.ts:271确认默认关闭,
// harbor_dao_agent.py 从未传这个flag),这个机制在任何一次真实terminal-bench评测里
// 都不会触发——这是此前两个独立会话(make-mips-interpreter/path-tracing-reverse排查)
// 分别发现的关键盲区。largest-eigenval这次trial全程14次工具调用,0次触碰PROGRESS_TOOLS
// (Write/Edit/MultiEdit/NotebookEdit/TodoWrite),如果开着progress-advice,真实会话里
// 在第5次和第10次工具调用后就该收到过提醒(loop.ts:525/535-538),现在都还没走到decision
// point就已经该提醒两次。
//
// 本脚本把 loop.ts 里那两条真实提醒文案(逐字复制,非改写)作为累计的 advisory 追加消息
// 插在真实历史messages[0..29]之后,模拟"如果这两次提醒真的发生过,模型在同一个决策点
// 会不会做出不同选择"。
//
// 跑法: VOLCENGINE_API_KEY=... npx tsx scripts/verify-largest-eigenval-tier2-replay.ts
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
const baseMessages: ChatMessage[] = state.messages.slice(0, 30); // messages[0..29]

// loop.ts:535(第1次,通用措辞)+ loop.ts:537(第2次,stuckAdviceCount>1 升级措辞),逐字复制。
const REMINDER_1 =
  "[进度提醒] 已连续 5 轮没有改动文件或推进任务清单。如果你在反复用文字重新推导同一个" +
  "不确定的点(某个数值/坐标/参数/配置该怎么定),现在就停下来,换成一个能给出确切答案的" +
  "动作代替继续假设——写脚本算出来、跑命令查、或读文档确认,拿到确定结果再往下走,不要" +
  "继续在文字里循环论证同一个问题;哪怕设计还没完全想清楚,也先写一个不完整的最小版本" +
  "落地,让验证暴露剩下的问题。如果已经完成,请派 verify 子代理验证后收尾;如果确实卡住了," +
  "用 AskUserQuestion 向用户求助,不要空转。";
const REMINDER_2 =
  "[进度提醒·第2次] 已连续 10 轮没有改动文件或推进任务清单,前面提醒过 1 次仍没有推进——" +
  "这通常意味着你还在原地用文字重新论证同一个问题。现在必须切换成具体动作:写脚本算出来、" +
  "跑命令查、或读文档确认,拿到确定结果再往下走,不要继续在文字里循环论证;哪怕设计还没" +
  "完全想清楚,也先写一个不完整的最小版本落地。如果确实卡住了,用 AskUserQuestion 求助或" +
  "如实汇报现状。";

const withTier2Reminders: ChatMessage[] = [
  ...baseMessages,
  { role: "system", content: REMINDER_1 },
  { role: "system", content: REMINDER_2 },
];

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
    const result = await complete(messages);
    const wrote = findsWriteToEigen(result.tool_calls);
    const otherTools = (result.tool_calls ?? []).map((t) => t.function.name).join(",") || "(无工具调用)";
    console.log(`  样本${i + 1}: ${wrote ? "✅ 写了 eigen.py" : `❌ 未写 (${otherTools})`}`);
    const reasoning = (result as unknown as { reasoningContent?: string }).reasoningContent;
    if (reasoning) console.log(`    reasoning节选(前600字):\n${reasoning.slice(0, 600)}\n`);
    if (wrote) hits++;
  }
  console.log(`  ${label} 命中率: ${hits}/${n}`);
  return hits;
}

const n = Number(process.env.VERIFY_N) || 3;
const hits = await runSamples("Tier2(累计2次进度提醒后)", withTier2Reminders, n);
console.log(`\n=== 结果 ===\nTier2候选: ${hits}/${n}`);
