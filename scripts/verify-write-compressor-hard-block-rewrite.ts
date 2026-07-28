// 快速验证(debug-evolve 第四步):候选A的加强版——对write-compressor真实卡点做"硬拒绝"机制的
// 重放验证。参照 write_file.ts:46-47 已有的真实先例("覆盖已存在文件前必须先 Read,没读直接
// throw Error"),新候选:对同一路径连续两次 Write、中间没有任何 Bash/exec_shell 调用,直接
// 拒绝第二次 Write 并说明原因,要求先执行验证或改用 Edit 做局部修正。
//
// 真实卡点(retest-antistall-write-compressor-0727,state.json 持久化到 msg 26 为止,即第一次
// Write /app/compress.rs 成功的那一刻——第二次 Write 在真实会话里是被900s杀掉前刚起了个头,
// 从未完整持久化,dao_stdout.txt 显示之后是纯文字推理(line 2653-2758,~100行)最终决定"重写"
// 后被截断)。本脚本从 msg[0..26] 原样续跑,看:
//   (1) 自然续跑(无候选)时,是否重现"不编译直接再 Write"的模式;
//   (2) 如果重现了,注入模拟的拒绝错误(而不是真的实现代码),看模型下一步是不是真的转去跑
//       Bash 验证/用 Edit 做局部修正,而不是绕过或重复触发同一个错误。
//
// 跑法: VOLCENGINE_API_KEY=... VERIFY_N=3 npx tsx scripts/verify-write-compressor-hard-block-rewrite.ts
import { promises as fs } from "node:fs";
import { streamChat } from "../src/client/client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { readFileTool } from "../src/tools/read_file.js";
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
  "/Users/huaruoxu/ClaudeProject/dao-code/evals/terminal-bench/jobs/retest-antistall-write-compressor-0727/" +
  "write-compressor__q37SjPz/agent/dao_snapshot/.dao/sessions/20260727-152939-frdp/state.json";

const state = JSON.parse(await fs.readFile(STATE_PATH, "utf8")) as { messages: ChatMessage[] };
const baseMessages: ChatMessage[] = state.messages; // 27条,到"第一次Write成功"的tool result为止

const registry = new ToolRegistry();
for (const t of [readFileTool, writeFileTool, editFileTool, multiEditTool, execShellTool, grepFilesTool, fileSearchTool, todoWriteTool]) registry.register(t);
const tools = registry.toApiTools(undefined, "en");

async function complete(msgs: ChatMessage[]) {
  const gen = streamChat({ baseUrl, apiKey, provider: "volcengine", model, messages: msgs, tools, parallelToolCalls: true, extra: { reasoning_effort: "low" } });
  let result;
  while (true) { const { value, done } = await gen.next(); if (done) { result = value; break; } }
  return result;
}

function findsWriteToPath(tc: ToolCall[] | undefined, pathFragment: string): ToolCall | undefined {
  return (tc ?? []).find((t) => t.function.name === "Write" && t.function.arguments.includes(pathFragment));
}
function findsBashOrExec(tc: ToolCall[] | undefined): ToolCall | undefined {
  return (tc ?? []).find((t) => t.function.name === "Bash");
}
function findsEdit(tc: ToolCall[] | undefined): ToolCall | undefined {
  return (tc ?? []).find((t) => t.function.name === "Edit" || t.function.name === "MultiEdit");
}

// 模拟的拒绝消息(候选实现的产出物,尚未写进代码,这里手写模拟其返回文案以验证行为反应)。
const REJECTION_MSG =
  "拒绝写入:你正在整篇重写 /app/compress.rs,但自上次写入以来还没有执行过任何命令去验证那一版本。" +
  "写下来的版本比只存在于推理里的完美设计更有价值——先运行它拿到真实反馈(哪怕只是编译错误)," +
  "不要凭记忆判断'这版思路不对'就整篇丢弃重写。如果你已经明确知道具体哪里错了、想做局部修正," +
  "用 Edit/MultiEdit 针对性修改不受此限制;如果确实需要先验证,现在就去跑一下上一版" +
  "(例如 rustc compress.rs -o compress && ./compress < data.txt > /tmp/test.comp && cat /tmp/test.comp | ./decomp)。";

async function runSample(i: number) {
  console.error(`\n--- 样本 ${i} ---`);
  const msgs1 = [...baseMessages];
  const r1 = await complete(msgs1);
  const wroteAgain = findsWriteToPath(r1.tool_calls, "compress.rs");
  const ranBash = findsBashOrExec(r1.tool_calls);
  const usedEdit = findsEdit(r1.tool_calls);
  console.log(`  第1轮(自然续跑): ${wroteAgain ? "再次 Write compress.rs" : ranBash ? "先跑 Bash" : usedEdit ? "用 Edit 局部修改" : `其它(${(r1.tool_calls ?? []).map(t=>t.function.name).join(",") || "无工具调用"})`}`);

  if (!wroteAgain) {
    console.log("  (未复现'不编译就重写'这个模式,本样本无法测试拒绝候选的效果)");
    return { reproduced: false, complied: null as boolean | null };
  }

  // 复现了目标模式:模拟候选机制介入,把这次 Write 的"结果"换成拒绝说明,而不是真的执行写入。
  const msgs2: ChatMessage[] = [
    ...msgs1,
    { role: "assistant", content: r1.content ?? "", tool_calls: r1.tool_calls },
    { role: "tool", tool_call_id: wroteAgain.id, content: REJECTION_MSG },
  ];
  const r2 = await complete(msgs2);
  const ranBashAfterReject = findsBashOrExec(r2.tool_calls);
  const usedEditAfterReject = findsEdit(r2.tool_calls);
  const wroteAgainAfterReject = findsWriteToPath(r2.tool_calls, "compress.rs");
  const complied = !!(ranBashAfterReject || usedEditAfterReject);
  console.log(`  第2轮(注入拒绝后): ${ranBashAfterReject ? "✅ 转去跑 Bash 验证" : usedEditAfterReject ? "✅ 改用 Edit 局部修正" : wroteAgainAfterReject ? "❌ 又尝试整篇 Write(重复触发同一个拒绝)" : `⚠️ 其它(${(r2.tool_calls ?? []).map(t=>t.function.name).join(",") || "无工具调用,content="+String(r2.content).slice(0,150)})`}`);
  return { reproduced: true, complied };
}

const n = Number(process.env.VERIFY_N) || 3;
let reproducedCount = 0, compliedCount = 0;
for (let i = 1; i <= n; i++) {
  const r = await runSample(i);
  if (r.reproduced) { reproducedCount++; if (r.complied) compliedCount++; }
}
console.log(`\n=== 汇总 ===\n复现"不编译就重写": ${reproducedCount}/${n}\n复现样本里,注入拒绝后转去验证/局部修正: ${compliedCount}/${reproducedCount || 1}`);
