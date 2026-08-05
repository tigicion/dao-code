// 快速验证(debug-evolve 第四步):候选——"连续第2次撞见同一类'缺模块/库'报错时,
// 拒绝再来一次纯诊断性探测,逼模型在'装库'/'改用参考实现本身的精度写原生实现'之间二选一"。
//
// 背景:同目录 verify-write-compressor-missing-dep-default-replay.ts 已经验证过纯文字提醒
// (哪怕精确注入在报错发生的那一轮)完全无效——5个样本里4个仍然在"到底该试Math::BigInt
// 还是bigint pragma"上打转,两组(注入/不注入)推理原文近乎逐字重复。这条候选换成本次
// session 里唯一验证成功过两次的机制类型(write-compressor重写拦截、TodoWrite enforcement):
// 不是建议,是真的拒绝执行。
//
// 真实卡点:messages[0..28](到第2次缺库报错为止)。msg26 = 缺 Math::BigInt;msg27 = 模型
// 换了个名字试 `-Mbigint`;msg28 = 缺 bigint 模块(第2次同类报错)。真实trace里msg29的
// 下一步是纯诊断探测(dump @INC + ls 系统目录),不是装库也不是换写法。
//
// 候选设计:检测到"exec_shell 结果匹配缺模块/库报错特征"达到第2次时,如果模型下一步的
// Bash 调用仍然是"纯诊断性探测"(用一份跨语言的封闭模式表:-M<Module>/import 探测/which/
// find name/dpkg -l/apt list/ldconfig -p 等"查这个库在不在"类命令,不含真正的安装命令
// 关键字如 apt-get install/cpan/pip install),就拒绝执行,要求先在"装库"或"换成不依赖
// 这个库的写法"之间做一个选择。安装命令类的调用不拦截——那本身就是候选希望看到的合理选择。
//
// 跑法: VOLCENGINE_API_KEY=... VERIFY_N=4 npx tsx scripts/verify-write-compressor-missing-dep-hard-block-replay.ts
import { promises as fs } from "node:fs";
import { streamChat } from "../src/client/client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { readFileTool } from "../src/tools/read_file.js";
import { listDirTool } from "../src/tools/list_dir.js";
import { writeFileTool } from "../src/tools/write_file.js";
import { editFileTool } from "../src/tools/edit_file.js";
import { execShellTool } from "../src/tools/exec_shell.js";
import { grepFilesTool } from "../src/tools/grep_files.js";
import { todoWriteTool } from "../src/tools/todo_write.js";
import type { ChatMessage, ToolCall } from "../src/client/types.js";

const apiKey = process.env.VOLCENGINE_API_KEY ?? "";
const baseUrl = "https://ark.cn-beijing.volces.com/api/coding/v3";
const model = "deepseek-v4-pro";
if (!apiKey) { console.error("需要 VOLCENGINE_API_KEY。"); process.exit(1); }

const STATE_PATH =
  "/Users/huaruoxu/ClaudeProject/dao-code/evals/terminal-bench/jobs/retest-todowrite-write-compressor-0728/" +
  "write-compressor__wRmYB9T/agent/dao_snapshot/.dao/sessions/20260728-081857-jy02/state.json";

const state = JSON.parse(await fs.readFile(STATE_PATH, "utf8")) as { messages: ChatMessage[] };
// 到 msg28(第2次缺库报错)为止——msg0..28 共 29 条。
const baseMessages: ChatMessage[] = state.messages.slice(0, 29);

const registry = new ToolRegistry();
for (const t of [readFileTool, listDirTool, writeFileTool, editFileTool, execShellTool, grepFilesTool, todoWriteTool]) {
  registry.register(t);
}
const tools = registry.toApiTools(undefined, "en");

async function requestOnce(msgs: ChatMessage[]) {
  const gen = streamChat({
    baseUrl, apiKey, provider: "volcengine", model, messages: msgs,
    tools, parallelToolCalls: true,
    extra: { reasoning_effort: "low" },
  });
  let result;
  while (true) { const { value, done } = await gen.next(); if (done) { result = value; break; } }
  return result;
}

function getCommand(tc: ToolCall | undefined): string {
  if (!tc) return "";
  try { return (JSON.parse(tc.function.arguments) as { command?: string }).command ?? ""; } catch { return ""; }
}

// 封闭的"纯诊断探测"模式(跨语言,不针对本题写死):查模块/库在不在、叫什么名字,但不是
// 真正安装、也不是切到不依赖它的写法。
const DIAGNOSE_PATTERNS = [
  /-m[a-z:]+\s/i, // perl -Mxxx
  /use\s+bigint/i,
  /import\s+\w+/i,
  /\bwhich\b/i,
  /\blocate\b/i,
  /find\s+\/\S*\s+-name/i,
  /dpkg\s+-l/i,
  /apt\s+list/i,
  /ldconfig\s+-p/i,
  /pip\s+show/i,
  /@inc/i,
];
const INSTALL_PATTERNS = [/apt-get install/i, /apt install/i, /\bcpan\b/i, /\bcpanm\b/i, /pip install/i, /pip3 install/i];

function isBareDiagnosticProbe(command: string): boolean {
  if (INSTALL_PATTERNS.some((p) => p.test(command))) return false;
  return DIAGNOSE_PATTERNS.some((p) => p.test(command));
}

function summarize(tc: ToolCall | undefined): string {
  if (!tc) return "(无工具调用,纯文本)";
  return `${tc.function.name}(${tc.function.arguments.slice(0, 200)})`;
}

async function runBaseline(n: number) {
  console.error(`\n[verify] ①不拦截(自然续跑): ${n} 个样本…`);
  let stillProbes = 0;
  for (let i = 1; i <= n; i++) {
    const r = await requestOnce(baseMessages);
    const firstCall = r.tool_calls?.[0];
    const cmd = getCommand(firstCall);
    const probe = firstCall?.function.name === "Bash" && isBareDiagnosticProbe(cmd);
    if (probe) stillProbes++;
    console.log(`  样本${i}: ${summarize(firstCall)}  ${probe ? "[纯诊断探测]" : ""}`);
  }
  console.log(`  ①仍在纯诊断探测: ${stillProbes}/${n}`);
  return stillProbes;
}

async function runHardBlock(n: number) {
  console.error(`\n[verify] ②硬拒绝(第2次报错后,下一步若仍是纯诊断探测就拒绝执行): ${n} 个样本…`);
  let genuinePivotOrInstall = 0;
  let rationalizesAway = 0;
  let noTrigger = 0;
  for (let i = 1; i <= n; i++) {
    const round1 = await requestOnce(baseMessages);
    const firstCall = round1.tool_calls?.[0];
    const cmd = getCommand(firstCall);
    if (!firstCall || firstCall.function.name !== "Bash" || !isBareDiagnosticProbe(cmd)) {
      console.log(`  样本${i}: 第一轮=${summarize(firstCall)} 不是纯诊断探测,候选无需介入`);
      noTrigger++;
      continue;
    }
    const msgsWithRejection: ChatMessage[] = [
      ...baseMessages,
      { role: "assistant", content: round1.content, tool_calls: round1.tool_calls, reasoningContent: round1.reasoningContent },
      {
        role: "tool",
        tool_call_id: firstCall.id,
        content:
          "[操作被拒绝] 你已经连续第2次撞见\"缺少这个模块/库\"的报错,这次调用仍然只是在" +
          "换个名字/换个角度确认这个库到底在不在——不会执行。现在必须做一个选择再继续:" +
          "(a) 用包管理器/等价工具实际安装它,或 (b) 改用不依赖这个库的写法(比如参考/规范" +
          "实现本身用到的定长整数运算)。选定后直接去做,不要再运行任何只是\"检查一下\"的命令。",
      },
    ];
    const round2 = await requestOnce(msgsWithRejection);
    const secondCall = round2.tool_calls?.[0];
    const secondCmd = getCommand(secondCall);
    const secondIsInstall = !!secondCall && secondCall.function.name === "Bash" && INSTALL_PATTERNS.some((p) => p.test(secondCmd));
    const secondIsProbe = !!secondCall && secondCall.function.name === "Bash" && isBareDiagnosticProbe(secondCmd);
    const preview2 = (round2.reasoningContent ?? round2.content ?? "").slice(0, 350).replace(/\n/g, " ");
    console.log(`  样本${i}: 第一轮=${summarize(firstCall)}\n    → 拒绝后第二轮=${summarize(secondCall)}${secondIsInstall ? "  [真装库]" : secondIsProbe ? "  [仍是纯诊断,绕过拦截]" : "  [疑似真正切换写法]"}`);
    if (preview2) console.log(`    推理节选: ${preview2}`);
    if (secondIsProbe) rationalizesAway++;
    else genuinePivotOrInstall++;
  }
  console.log(`\n  ②汇总: 真的装库或切换写法=${genuinePivotOrInstall}  仍绕回纯诊断=${rationalizesAway}  未触发拦截=${noTrigger}`);
}

const n = Number(process.env.VERIFY_N) || 4;
await runBaseline(n);
await runHardBlock(n);
