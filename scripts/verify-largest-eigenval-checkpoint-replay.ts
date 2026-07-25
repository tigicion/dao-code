// 快速验证(第四步):largest-eigenval 真实卡点(jobs/largest-eigenval/iter-largest-eigenval-0721/
// largest-eigenval__AG6qGT7)。复原真实历史 messages[0..29](t≈841s,最后一次工具结果已经测出
// dgeev 在全部5个尺寸上稳定超过 numpy,含10x10仅1.07x这个"勉强达标"的样本),这是真实会话里
// 下一步就该决定"写不写盘"的决策点(真实会话在这之后继续设想 numba/Cython 等方案,直到
// 900s 超时,eigen.py 从未被写过)。
//
// baseline:原样系统提示词(messages[0] 逐字节复用真实捕获的版本)。
// candidate:在"Write-first for new files"条款末尾("...cannot be tested."之后)插入内省诊断
// 层2里模型自己建议的那句话的精修版,只改这一处文字,其它字节完全一致——隔离变量。
//
// 跑法: VOLCENGINE_API_KEY=... npx tsx scripts/verify-largest-eigenval-checkpoint-replay.ts
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
const CUT = 30; // messages[0..29],index 29 是真实最后一次工具结果(dgeev 全尺寸 benchmark)
const baseMessages: ChatMessage[] = state.messages.slice(0, CUT);
const originalSystemPrompt = baseMessages[0].content as string;

const ANCHOR =
  '  feedback. "Write it down" means calling the Write tool, not producing more reasoning text — code in your reasoning\n' +
  "  is invisible to the system and cannot be tested.\n";
if (!originalSystemPrompt.includes(ANCHOR)) {
  console.error("[verify] 锚点文本没匹配上,系统提示词可能已变化,脚本需要更新锚点。");
  process.exit(1);
}
const INSERTION =
  "  This also applies once a result already meets the task's literal acceptance bar (e.g. clears a stated\n" +
  "  threshold, however narrowly, or satisfies the given check): write it now as a checkpoint — chasing a bigger\n" +
  "  margin afterward is fine, but not before that checkpoint exists on disk.\n";
const candidateSystemPrompt = originalSystemPrompt.replace(ANCHOR, ANCHOR + INSERTION);

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
  return (tc ?? []).find(
    (t) => t.function.name === "Write" && /eigen\.py/.test(t.function.arguments),
  );
}

async function runSamples(label: string, systemPrompt: string, n: number) {
  console.error(`\n[verify] ${label}: ${n} 个样本…`);
  let hits = 0;
  for (let i = 0; i < n; i++) {
    const msgs: ChatMessage[] = [{ ...baseMessages[0], content: systemPrompt }, ...baseMessages.slice(1)];
    const result = await complete(msgs);
    const wrote = findsWriteToEigen(result.tool_calls);
    const otherTools = (result.tool_calls ?? []).map((t) => t.function.name).join(",") || "(无工具调用)";
    console.log(`  样本${i + 1}: ${wrote ? "✅ 写了 eigen.py" : `❌ 未写 (${otherTools})`}`);
    if (result.content) console.log(`    content节选: ${result.content.slice(0, 200).replace(/\n/g, " ")}`);
    const reasoning = (result as unknown as { reasoningContent?: string }).reasoningContent;
    if (reasoning) console.log(`    reasoning(全文):\n${reasoning}\n`);
    for (const tc of result.tool_calls ?? []) console.log(`    调用: ${tc.function.name}(${tc.function.arguments.slice(0, 300)})`);
    if (wrote) hits++;
  }
  console.log(`  ${label} 命中率: ${hits}/${n}`);
  return hits;
}

const onlyCandidate = process.argv.includes("--candidate-only");
const n = Number(process.env.VERIFY_N) || 3;
const baselineHits = onlyCandidate ? 0 : await runSamples("baseline(原始提示词)", originalSystemPrompt, n);
const candidateHits = await runSamples("candidate(加了checkpoint句)", candidateSystemPrompt, n);

console.log(`\n=== 最终对比 ===\nbaseline: ${baselineHits}/${onlyCandidate ? "(跳过)" : n}\ncandidate: ${candidateHits}/${n}`);
