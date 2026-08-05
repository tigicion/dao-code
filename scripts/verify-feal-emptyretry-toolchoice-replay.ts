// 快速验证:feal-differential-cryptanalysis 的预算耗尽死亡螺旋修复(c51fe55)到底是
// tool_choice=required 起作用,还是加大 max_tokens 起作用,还是两者都要——五组对照,
// 同一个真实决策点(state.json messages[0..8]),只改请求参数。
//
// 决策点:messages[8] 正是 loop.ts 那条"[提示] 上一轮的思考过程用尽了输出预算…第一步
// 必须是一次工具调用"的真实注入文案(逐字复制自 20260727-072842-30rd 这次真实 trial),
// 也是这份历史里的最后一条消息——它之后的那次真实重试(旧代码:effort=low,
// maxTokens=6000,无 tool_choice)拿到的是第二次空响应,触发"连续两次空响应,结束本轮"
// 直接把这次 trial 判成 reward=0(无 exception,干净失败)。
//
// 五组:
//   ① 旧基线   maxTokens=6000  tool_choice=无        全量工具集   — 复现空响应,不然整个重放不可信
//   ② 只放预算 maxTokens=16000 tool_choice=无        全量工具集   — 光给空间够不够
//   ③ 只强制   maxTokens=6000  tool_choice=required  生产性工具集 — 强制本身够不够(小预算+强制)
//   ④ 新默认1  maxTokens=16000 tool_choice=required  生产性工具集 — c51fe55 第一档
//   ⑤ 新默认2  maxTokens=32000 tool_choice=required  生产性工具集 — c51fe55 第二档
// 全部固定 reasoning_effort=low(原代码里这一档本就用 low,不是新引入的变量)。
//
// 判定标准:有没有吐出 tool_calls,是不是 FORCED_TOOLS 里那几个能产出/执行的工具——
// 不评价内容好坏,只看这一步有没有从"空转"变成"动手"。
//
// 已知的混淆变量:③④⑤同时改了 tool_choice 和工具集,分不出两者各自贡献。先跑这五组,
// 只有④/⑤命中率不稳时才值得再加一组"maxTokens=16000+tool_choice=required+全量工具集"
// 来拆解。
//
// 跑法: VOLCENGINE_API_KEY=... VERIFY_N=5 npx tsx scripts/verify-feal-emptyretry-toolchoice-replay.ts
import { promises as fs } from "node:fs";
import { streamChat } from "../src/client/client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { readFileTool } from "../src/tools/read_file.js";
import { writeFileTool } from "../src/tools/write_file.js";
import { editFileTool } from "../src/tools/edit_file.js";
import { multiEditTool } from "../src/tools/multi_edit.js";
import { notebookEditTool } from "../src/tools/notebook_edit.js";
import { execShellTool } from "../src/tools/exec_shell.js";
import { grepFilesTool } from "../src/tools/grep_files.js";
import { fileSearchTool } from "../src/tools/file_search.js";
import { todoWriteTool } from "../src/tools/todo_write.js";
import { skillTool } from "../src/tools/skill.js";
import type { ChatMessage, ToolCall, ApiTool } from "../src/client/types.js";

const apiKey = process.env.VOLCENGINE_API_KEY ?? "";
const baseUrl = "https://ark.cn-beijing.volces.com/api/coding/v3";
const model = "deepseek-v4-pro";
if (!apiKey) { console.error("需要 VOLCENGINE_API_KEY。"); process.exit(1); }

const STATE_PATH =
  "/Users/huaruoxu/ClaudeProject/dao-code/evals/terminal-bench/jobs/freshlens-confirm-restore-0727-r2/" +
  "feal-differential-cryptanalysis__PRWeyyZ/agent/dao_snapshot/.dao/sessions/20260727-072842-30rd/state.json";

const state = JSON.parse(await fs.readFile(STATE_PATH, "utf8")) as { messages: ChatMessage[] };
const decisionPoint: ChatMessage[] = state.messages.slice(0, 9); // messages[0..8],含最后那条"提示收敛"注入
if (decisionPoint.length !== 9) {
  console.error(`预期 9 条消息,实际读到 ${decisionPoint.length} 条,STATE_PATH 可能不对。`);
  process.exit(1);
}

const registry = new ToolRegistry();
for (const t of [
  readFileTool, writeFileTool, editFileTool, multiEditTool, notebookEditTool,
  execShellTool, grepFilesTool, fileSearchTool, todoWriteTool, skillTool,
]) registry.register(t);

const FULL_TOOLS = registry.toApiTools(undefined, "en");
// 与 loop.ts 的 FORCED_TOOLS 完全一致(能写盘/能执行的那几个,不含 Read/Grep/Glob/Skill/TodoWrite)。
const FORCED_NAMES = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]);
const FORCED_TOOLS: ApiTool[] = FULL_TOOLS.filter((t) => FORCED_NAMES.has(t.function.name));

interface Group {
  label: string;
  maxTokens?: number;
  toolChoice?: "required";
  tools: ApiTool[];
}
const groups: Group[] = [
  { label: "① 旧基线(6000, 无强制, 全量工具)", maxTokens: 6000, tools: FULL_TOOLS },
  { label: "② 只放预算(16000, 无强制, 全量工具)", maxTokens: 16000, tools: FULL_TOOLS },
  { label: "③ 只强制(6000, required, 生产性工具)", maxTokens: 6000, toolChoice: "required", tools: FORCED_TOOLS },
  { label: "④ 新默认第一档(16000, required, 生产性工具)", maxTokens: 16000, toolChoice: "required", tools: FORCED_TOOLS },
  { label: "⑤ 新默认第二档(32000, required, 生产性工具)", maxTokens: 32000, toolChoice: "required", tools: FORCED_TOOLS },
];

async function complete(g: Group) {
  const gen = streamChat({
    baseUrl,
    apiKey,
    provider: "volcengine",
    model,
    messages: decisionPoint,
    tools: g.tools,
    parallelToolCalls: true,
    extra: {
      reasoning_effort: "low",
      ...(g.toolChoice ? { tool_choice: g.toolChoice } : {}),
    },
    ...(g.maxTokens ? { maxTokens: g.maxTokens } : {}),
  });
  let result;
  let rejected: string | undefined;
  try {
    while (true) {
      const { value, done } = await gen.next();
      if (done) { result = value; break; }
    }
  } catch (e) {
    rejected = e instanceof Error ? e.message : String(e);
  }
  return { result, rejected };
}

function judge(tc: ToolCall[] | undefined): string {
  if (!tc || tc.length === 0) return "❌ 空响应(无 tool_calls)";
  const names = tc.map((t) => t.function.name);
  const productive = names.some((n) => FORCED_NAMES.has(n));
  return productive ? `✅ 产出型工具调用(${names.join(",")})` : `⚠️ 非产出型工具调用(${names.join(",")})`;
}

async function runGroup(g: Group, n: number) {
  console.error(`\n[verify] ${g.label}: ${n} 个样本…`);
  const outcomes: string[] = [];
  for (let i = 0; i < n; i++) {
    const { result, rejected } = await complete(g);
    if (rejected) {
      outcomes.push("🚫 被服务端拒绝(tool_choice 不支持?)");
      console.log(`  样本${i + 1}: 🚫 请求被拒: ${rejected.slice(0, 200)}`);
      continue;
    }
    const verdict = judge(result?.tool_calls);
    outcomes.push(verdict);
    const finishReason = (result as unknown as { finishReason?: string })?.finishReason;
    console.log(`  样本${i + 1}: ${verdict}${finishReason ? ` (finish_reason=${finishReason})` : ""}`);
  }
  const hits = outcomes.filter((o) => o.startsWith("✅")).length;
  console.log(`  ${g.label} 产出型命中率: ${hits}/${n}`);
  return { label: g.label, hits, n, outcomes };
}

const n = Number(process.env.VERIFY_N) || 3;
const summary: { label: string; hits: number; n: number }[] = [];
for (const g of groups) {
  const r = await runGroup(g, n);
  summary.push(r);
}
console.log("\n=== 汇总 ===");
for (const s of summary) console.log(`${s.label}: ${s.hits}/${s.n}`);

// 追加探针(非五组正式对照的一部分):生产代码里 tool_choice 在火山被拒后会静默降级——
// 第二档(32000)的 attempt() 因为 forcingUnsupported 已经在第一次被置真,会直接跳过强制,
// 落到"32000+无强制+全量工具"。这一组模拟生产环境在这个 provider 上第二档实际会跑到哪。
if (process.env.VERIFY_ESCALATED_FALLBACK) {
  await runGroup({ label: "⑥ 生产环境第二档实际落点(32000, 无强制【因429被拒后降级】, 全量工具)", maxTokens: 32000, tools: FULL_TOOLS }, n);
}

// 追加探针②:既然 tool_choice 在火山上永远不生效,回退路径能不能至少保留"工具集收窄"这道
// 防线(不强制,但仍然只暴露生产性工具),而不是回退到全量工具集(包含 Skill/TodoWrite 这类
// 元工具逃生口)?对照⑥,唯一变量是工具集。
if (process.env.VERIFY_NARROWED_FALLBACK) {
  await runGroup({ label: "⑦ 不强制但仍收窄工具集(32000, 无强制, 生产性工具)", maxTokens: 32000, tools: FORCED_TOOLS }, n);
}
