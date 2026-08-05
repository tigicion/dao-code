// 快速验证(debug-evolve 第四步):候选——"缺依赖时默认走更简单方案,别在诊断上打转"。
// 用户直接引用 ForgeCode 博客"Non-Interactive Mode"修复的后两点措辞:
//   "Tool behavior changed so the agent assumes reasonable defaults and proceeds"
//   "Completion logic tightened so the agent commits to an answer rather than hedging"
// 要求把这次"过度依赖高精度数值库"的发现,往这两点上靠。
//
// 真实卡点(retest-todowrite-write-compressor-0728,write-compressor__wRmYB9T,
// state.json messages[0..32]):模型选 Perl 写压缩器,用了 Math::BigInt(msg21 起),
// 但同一份历史里 messages[4] 已经读过参考实现 decomp.c,其中只用 `int fraction;
// long range = 1;` 这类定长整数——大数库从一开始就不是任务要求。msg26 报
// "Can't locate Math/BigInt.pm in @INC",随后 msg27→msg31 连续 3 轮换着法子诊断
// 这同一个"库到底在不在/叫什么名字"的问题(试 -Mbigint、看 @INC 目录列表、
// find + 直接测试导入),没有一次退回去看"参考实现根本不需要大数"这个信息,
// 也没有做出"装它"或"换写法"里任意一个明确选择就往下走。这正是"遇到缺失能力时
// 继续犹豫式诊断,而不是假设一个合理默认值就走"的具体例子。
//
// 触发信号选跨语言、确定性可检测的"缺模块/库"报错特征(不针对 Perl/Math::BigInt
// 这道题写死),命中即一次性注入(同 TodoWrite enforcement 的一次性触发模式)。
//
// 本脚本对比:①不注入(自然续跑,重放已知会连续多轮诊断) vs
//           ②注入候选提醒(检测到缺库报错后,下一轮是否转向"用参考实现的实际精度
//             写原生实现"或"一次性选定安装方式装完就走",而不是继续排查库本身)。
//
// 跑法: VOLCENGINE_API_KEY=... VERIFY_N=4 npx tsx scripts/verify-write-compressor-missing-dep-default-replay.ts
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
// 截到 msg26(缺 Math::BigInt 报错)为止——这是真实卡点,后面 msg27-31 是要重放对照的"自然续跑"。
const baseMessages: ChatMessage[] = state.messages.slice(0, 27);

// 候选文案:通用原则,不提 Perl/Math::BigInt/decomp.c 任何具体题面。
// 按 loop.ts 已有的 interactive/headless 分支模式(deps.interactive===false 时不建议
// AskUserQuestion,而是"按你此刻最合理的判断继续推进")——这里是同一类"没人能替你决定,
// 运行时必须让模型自己收敛"的场景,headless 分支的措辞更直接地点破"没有人会来解决这个不确定性"。
const CANDIDATE_MSG_HEADLESS =
  "[运行时提醒] 你刚尝试运行的命令因为缺少一个外部模块/库而报错。这是非交互式运行,不会有人" +
  "替你决定接下来怎么办——继续切换排查手段去确认这个库到底在不在、叫什么名字,只是在把决策" +
  "往后拖,不会有新信息让这个决定变得更容易。现在就自己做一个选择并继续:如果参考/规范实现" +
  "本身用的是更简单的能力(比如语言内置的定长整数运算),就直接换成不依赖这个库的写法,不要因为" +
  "\"更保险\"就引入额外依赖;如果确实需要这个库,选一种安装方式(包管理器,或系统里已有的等价" +
  "替代)试一次就定下来。两者选一个,现在就推进,不要继续诊断这个库本身。";
const CANDIDATE_MSG_INTERACTIVE =
  "[运行时提醒] 你刚尝试运行的命令因为缺少一个外部模块/库而报错。在花更多轮次去安装或定位" +
  "这个库之前,先确认一件事:达成目标是不是真的必须依赖它——如果参考/规范实现本身用的是更" +
  "简单的能力(比如语言内置的定长整数运算),就直接换成不依赖这个库的写法,不要因为\"更保险\"" +
  "就引入额外依赖。如果确实需要这个库,选一种安装方式(包管理器,或系统里已有的等价替代)试一次" +
  "就定下来,不要反复切换排查手段去确认这个库到底在不在、叫什么名字——用一个明确的选择把这一步" +
  "推进下去,而不是继续在诊断上打转。";
// terminal-bench/harbor 真实评测跑的就是 headless 路径(--goal/eval,无人值守),这里用 headless 版本。
const CANDIDATE_MSG = CANDIDATE_MSG_HEADLESS;

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

// 分类下一步动作:
//   pivot   = 换成不依赖外部大数库的写法(原生 int/long 运算,或明确说明不需要大数)
//   install = 一次性选定装库(apt/cpan 等)并继续,不是"先看看有没有"
//   diagnose= 继续排查这个库本身在不在/叫什么名字(和 baseline msg27-31 同类)
//   other   = 其它(纯文本、切到完全不相关的动作)
function classify(tc: ToolCall[] | undefined, content: string | undefined): string {
  // 只取 "command" 字段本身(不含 description),避免 description 里的自然语言词误撞关键词
  // (踩过的坑:"Check Perl bigint availability" 里的 "int a" 被子串匹配命中成 "int ")。
  const argsRaw = (tc ?? []).map((t) => t.function.arguments).join(" ");
  let cmdOnly = argsRaw;
  try {
    const parsed = JSON.parse((tc ?? [])[0]?.function.arguments ?? "{}") as { command?: string };
    if (parsed.command) cmdOnly = (tc ?? []).map((t) => { try { return (JSON.parse(t.function.arguments) as { command?: string }).command ?? ""; } catch { return ""; } }).join(" ");
  } catch { /* 不是合法 JSON,退回整段参数字符串 */ }
  const text = ((content ?? "") + " " + cmdOnly).toLowerCase();
  const diagnoseHints = [/@inc/, /find \//, /\bwhich\b/, /\blocate\b/, /dpkg -l/, /apt list/, /ls \/usr/, /perl -m/, /-mbigint/];
  const installHints = [/\bcpan\b/, /apt-get install/, /apt install/, /\bcpanm\b/];
  const pivotHints = [/\bint\(/, /\bint\s+\$/, /\blong\b/, /native/, /定长/, /原生/, /不需要/, /不依赖/, /重写/, /unsigned/];
  if (installHints.some((h) => h.test(text))) return "install";
  const isDiagnose = diagnoseHints.some((h) => h.test(text));
  if (pivotHints.some((h) => h.test(text)) && !isDiagnose) return "pivot";
  if (isDiagnose) return "diagnose";
  return "other";
}

function summarize(tc: ToolCall[] | undefined): string {
  if (!tc?.length) return "(无工具调用,纯文本)";
  return tc.map((t) => `${t.function.name}(${t.function.arguments.slice(0, 200)})`).join(" | ");
}

async function runBaseline(n: number) {
  console.error(`\n[verify] ①不注入(自然续跑): ${n} 个样本…`);
  const tally: Record<string, number> = {};
  for (let i = 1; i <= n; i++) {
    const r = await requestOnce(baseMessages);
    const cls = classify(r.tool_calls, r.content);
    tally[cls] = (tally[cls] ?? 0) + 1;
    console.log(`  样本${i}: [${cls}] ${summarize(r.tool_calls)}`);
    const preview = (r.reasoningContent ?? r.content ?? "").slice(0, 350);
    if (preview) console.log(`    推理节选: ${preview.replace(/\n/g, " ")}\n`);
  }
  console.log(`  ①分布: ${JSON.stringify(tally)}`);
  return tally;
}

async function runCandidate(n: number) {
  console.error(`\n[verify] ②注入候选提醒: ${n} 个样本…`);
  const msgs: ChatMessage[] = [...baseMessages, { role: "system", content: CANDIDATE_MSG }];
  const tally: Record<string, number> = {};
  for (let i = 1; i <= n; i++) {
    const r = await requestOnce(msgs);
    const cls = classify(r.tool_calls, r.content);
    tally[cls] = (tally[cls] ?? 0) + 1;
    console.log(`  样本${i}: [${cls}] ${summarize(r.tool_calls)}`);
    const preview = (r.reasoningContent ?? r.content ?? "").slice(0, 350);
    if (preview) console.log(`    推理节选: ${preview.replace(/\n/g, " ")}\n`);
  }
  console.log(`  ②分布: ${JSON.stringify(tally)}`);
  return tally;
}

const n = Number(process.env.VERIFY_N) || 4;
const baseline = await runBaseline(n);
const candidate = await runCandidate(n);
console.log(`\n=== 汇总 ===\n①不注入: ${JSON.stringify(baseline)}\n②注入候选: ${JSON.stringify(candidate)}`);
