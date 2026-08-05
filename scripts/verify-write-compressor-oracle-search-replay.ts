// 快速验证(debug-evolve 第四步,轴1候选):"构造满足已知正向程序输出的输入时,优先把该
// 程序当oracle做二分/爬山搜索,而不是手推解析逆运算"。
//
// 真实卡点(retest-missingdep-write-compressor-0728,write-compressor__jmZnjdr,
// messages[0..5],读完decomp.c+data.txt、还没做任何实现决策的那一刻):模型最终选择手工
// 推导encode_bit的renormalization代数逆运算(而且推导中途还引入了"字节输出依赖bit值"这个
// 逻辑错误——renorm本该与bit值无关,但编码器把它俩耦合了),导致comp|decomp段错误。
//
// 三层内省诊断(introspect-write-compressor-encoder-decoder-asymmetry.ts)确认:
// - Layer0(不给答案):模型独立诊断出精确根因(renorm不该依赖bit值)。
// - Layer1(给出参考解法=用decoder当oracle二分查找):模型确认"根本没想到这个可能性",
//   不是想到但选择手推,是认知盲区。
// - Layer2(问系统提示词):模型自己指出3处措辞客观上推向了"手推"("低成本优先"被误读成
//   手推更便宜、"收敛到行动别陷入推敲"鼓励直接写第一个想法、"新文件先写盘"强化了这一点),
//   并自己提出了一条泛化程度恰当的候选规则(适用于"已知正向程序P,需要构造使P(X)=Y的X"
//   这一类场景,不只是这道题的压缩格式)。
//
// 本脚本:在messages[0..5](读完两个文件,还没做实现决策)这一刻,对比①原始系统提示词
// 续跑 vs ②插入候选新增条目后续跑,看模型下一步的实现思路是否从"手推代数逆"转向
// "把decomp当oracle做二分/搜索"。
//
// 跑法: VOLCENGINE_API_KEY=... VERIFY_N=4 npx tsx scripts/verify-write-compressor-oracle-search-replay.ts
import { promises as fs } from "node:fs";
import { streamChat } from "../src/client/client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { readFileTool } from "../src/tools/read_file.js";
import { writeFileTool } from "../src/tools/write_file.js";
import { execShellTool } from "../src/tools/exec_shell.js";
import { todoWriteTool } from "../src/tools/todo_write.js";
import type { ChatMessage, ToolCall } from "../src/client/types.js";

const apiKey = process.env.VOLCENGINE_API_KEY ?? "";
const baseUrl = "https://ark.cn-beijing.volces.com/api/coding/v3";
const model = "deepseek-v4-pro";
if (!apiKey) { console.error("需要 VOLCENGINE_API_KEY。"); process.exit(1); }

const STATE_PATH =
  "/Users/huaruoxu/ClaudeProject/dao-code/evals/terminal-bench/jobs/retest-missingdep-write-compressor-0728/" +
  "write-compressor__jmZnjdr/agent/dao_snapshot/.dao/sessions/20260728-091510-zqbg/state.json";

const state = JSON.parse(await fs.readFile(STATE_PATH, "utf8")) as { messages: ChatMessage[] };
const baseMessages: ChatMessage[] = state.messages.slice(0, 6); // 到读完两个文件为止

const ORIGINAL_HOOK = "A tool's default behavior or built-in auto-search/auto-tuning mechanism is often already the widest-coverage, best-performing strategy its designer chose;";

// 候选新增条目(英文,匹配这次真实trace用的英文系统提示词;通用原则,不提write-compressor/
// decomp.c/Perl等任何具体题面)。
const ORACLE_RULE =
  "- Inverse-construction oracle rule: when the task requires constructing an input X such that a known, runnable " +
  "forward program P produces a target output Y (e.g. inferring a compressor's input from a given decompressor, " +
  "finding a hash preimage, constructing input that passes a given parser), prefer treating P as a callable oracle " +
  "for search (binary search, hill-climbing, small-space brute force) over deriving P's analytical inverse by hand " +
  "— hand-deriving the inverse of an unfamiliar format is highly error-prone (one wrong step corrupts everything " +
  "downstream), while calling P itself is self-verifying and costs only extra runs. Only fall back to analytical " +
  "inversion when the search space is provably intractable and running P repeatedly is too expensive.\n";

function buildCandidateSystemPrompt(original: string): string {
  const idx = original.indexOf(ORIGINAL_HOOK);
  if (idx === -1) throw new Error("找不到插入锚点,系统提示词原文可能已变化");
  return original.slice(0, idx) + ORACLE_RULE + original.slice(idx);
}

const registry = new ToolRegistry();
for (const t of [readFileTool, writeFileTool, execShellTool, todoWriteTool]) registry.register(t);
const tools = registry.toApiTools(undefined, "en");

async function requestOnce(msgs: ChatMessage[]) {
  const gen = streamChat({
    baseUrl, apiKey, provider: "volcengine", model, messages: msgs,
    tools, parallelToolCalls: true,
    extra: { reasoning_effort: "medium" },
  });
  let result;
  while (true) { const { value, done } = await gen.next(); if (done) { result = value; break; } }
  return result;
}

const ORACLE_HINTS = [/oracle/i, /binary search/i, /二分/, /run.*decomp.*(candidate|guess|test)/i, /call.*decomp.*to (check|verify|test)/i, /brute[- ]?force/i];
const MANUAL_HINTS = [/renormali[sz]/i, /encode_bit/i, /split\s*=/i, /low\s*\*=?\s*(radix|255)/i, /fraction/i];

function classify(content: string | undefined, reasoning: string | undefined, tc: ToolCall[] | undefined): string {
  const text = `${reasoning ?? ""} ${content ?? ""} ${(tc ?? []).map((t) => t.function.arguments).join(" ")}`;
  const oracle = ORACLE_HINTS.some((h) => h.test(text));
  const manual = MANUAL_HINTS.some((h) => h.test(text));
  if (oracle && !manual) return "oracle";
  if (oracle && manual) return "both-mentioned";
  if (manual) return "manual-derivation";
  return "other";
}

async function run(label: string, msgs: ChatMessage[], n: number) {
  console.error(`\n[verify] ${label}: ${n} 个样本…`);
  const tally: Record<string, number> = {};
  for (let i = 1; i <= n; i++) {
    const r = await requestOnce(msgs);
    const cls = classify(r.content, r.reasoningContent, r.tool_calls);
    tally[cls] = (tally[cls] ?? 0) + 1;
    const preview = (r.reasoningContent ?? r.content ?? "").slice(0, 300).replace(/\n/g, " ");
    console.log(`  样本${i}: [${cls}]${preview ? ` ${preview}` : ""}`);
  }
  console.log(`  ${label} 分布: ${JSON.stringify(tally)}`);
  return tally;
}

const n = Number(process.env.VERIFY_N) || 4;
const baselineTally = await run("①原始系统提示词", baseMessages, n);
const candidateMsgs: ChatMessage[] = [
  { ...baseMessages[0]!, content: buildCandidateSystemPrompt(baseMessages[0]!.content as string) },
  ...baseMessages.slice(1),
];
const candidateTally = await run("②插入oracle候选条目", candidateMsgs, n);
console.log(`\n=== 汇总 ===\n①原始: ${JSON.stringify(baselineTally)}\n②候选: ${JSON.stringify(candidateTally)}`);
