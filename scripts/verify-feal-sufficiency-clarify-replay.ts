// 快速验证(debug-evolve 第四步):候选B——给"Multi-source verification for inferred parameters"
// 这条规则补一句区分"同一方法加大样本量"和"真正独立的方法",直接针对内省诊断出的具体歧义
// (模型把"256样本→2^32全量"套成了"两条独立路径",而这条规则原意是"用不同分析方法交叉验证")。
//
// 真实卡点(retest-antistall-feal-differential-cryptanalysis-0727,state.json 8条消息,到
// msg[7]——第一次 Bash 调用返回"256/256 样本全部输出 0x02000000"为止)。本脚本从 msg[0..7]
// 续跑,对比原始系统提示词 vs 补丁后的系统提示词,看模型下一步是直接写 attack.py,还是仍然
// 发起"更彻底验证"的第二次 Bash。
//
// 跑法: VOLCENGINE_API_KEY=... VERIFY_N=3 npx tsx scripts/verify-feal-sufficiency-clarify-replay.ts
import { promises as fs } from "node:fs";
import { streamChat } from "../src/client/client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { readFileTool } from "../src/tools/read_file.js";
import { writeFileTool } from "../src/tools/write_file.js";
import { execShellTool } from "../src/tools/exec_shell.js";
import { skillTool } from "../src/tools/skill.js";
import { todoWriteTool } from "../src/tools/todo_write.js";
import type { ChatMessage, ToolCall } from "../src/client/types.js";

const apiKey = process.env.VOLCENGINE_API_KEY ?? "";
const baseUrl = "https://ark.cn-beijing.volces.com/api/coding/v3";
const model = "deepseek-v4-pro";
if (!apiKey) { console.error("需要 VOLCENGINE_API_KEY。"); process.exit(1); }

const STATE_PATH =
  "/Users/huaruoxu/ClaudeProject/dao-code/evals/terminal-bench/jobs/" +
  "retest-antistall-feal-differential-cryptanalysis-0727/feal-differential-cryptanalysis__CdyHc3f/" +
  "agent/dao_snapshot/.dao/sessions/20260728-012100-cg47/state.json";

const state = JSON.parse(await fs.readFile(STATE_PATH, "utf8")) as { messages: ChatMessage[] };
const baseMessages: ChatMessage[] = state.messages; // 8条,到"256/256确认"的tool result为止

const ORIGINAL_RULE =
  "cross-check the value against that dataset before\n  finalizing — derive it a second, independent way from the data itself (geometry, photometry, or whatever the domain allows)\n  rather than trusting a single derivation path. If the two disagree, prefer the one independently reproducible from the data.";
const PATCHED_RULE =
  "cross-check the value against that dataset before\n  finalizing — derive it a second, independent way from the data itself (geometry, photometry, or whatever the domain allows)\n  rather than trusting a single derivation path. Re-running the SAME method with a larger sample size is not a second independent way —\n  if the first check already covered every structurally distinct case (every byte position, every branch of the logic) and gave a\n  uniform result, that conclusion is already established; further passes with the same method just spend budget without adding\n  real independence. If the two disagree, prefer the one independently reproducible from the data.";

const sysRaw = baseMessages[0]!.content as string;
if (!sysRaw.includes(ORIGINAL_RULE)) {
  console.error("原文没有精确匹配上,候选文本需要核对系统提示词是否已变化。");
  process.exit(1);
}
const patchedSys = sysRaw.replace(ORIGINAL_RULE, PATCHED_RULE);

const registry = new ToolRegistry();
for (const t of [readFileTool, writeFileTool, execShellTool, skillTool, todoWriteTool]) registry.register(t);
const tools = registry.toApiTools(undefined, "en");

async function complete(msgs: ChatMessage[]) {
  const gen = streamChat({ baseUrl, apiKey, provider: "volcengine", model, messages: msgs, tools, parallelToolCalls: true, extra: { reasoning_effort: "low" } });
  let result;
  while (true) { const { value, done } = await gen.next(); if (done) { result = value; break; } }
  return result;
}

function judge(tc: ToolCall[] | undefined): string {
  const bash = (tc ?? []).find((t) => t.function.name === "Bash");
  const write = (tc ?? []).find((t) => t.function.name === "Write" && t.function.arguments.includes("attack.py"));
  if (write) return "✅ 直接写 attack.py";
  if (bash) {
    const isFullRange = /range\(0x100000000\)|range\(4294967296\)|range\(2\s*\*\*\s*32\)/.test(bash.function.arguments);
    return isFullRange ? "❌ 又发起全量穷举验证(同一个卡点复现)" : "⚠️ 又发起了别的 Bash(需人工看是不是合理的下一步)";
  }
  return `⚠️ 其它(${(tc ?? []).map((t) => t.function.name).join(",") || "无工具调用"})`;
}

async function runGroup(label: string, sys: string, n: number) {
  console.error(`\n[verify] ${label}: ${n} 个样本…`);
  let hits = 0;
  for (let i = 1; i <= n; i++) {
    const msgs: ChatMessage[] = [{ role: "system", content: sys }, ...baseMessages.slice(1)];
    const r = await complete(msgs);
    const verdict = judge(r.tool_calls);
    console.log(`  样本${i}: ${verdict}`);
    if (verdict.startsWith("✅")) hits++;
  }
  console.log(`  ${label} 命中率: ${hits}/${n}`);
  return hits;
}

const n = Number(process.env.VERIFY_N) || 3;
const before = await runGroup("补丁前(原始系统提示词)", sysRaw, n);
const after = await runGroup("补丁后(加了sufficiency clarify)", patchedSys, n);
console.log(`\n=== 汇总 ===\n补丁前: ${before}/${n}\n补丁后: ${after}/${n}`);
