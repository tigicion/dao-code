// 快速验证(不进 harbor/docker):train-fasttext 真实卡点复盘。
//
// 历史事实(2026-07-15,jobs/train-fasttext/iter13-fasttext-rerun/train-fasttext__HtxYbXX,
// tool-trace.jsonl 第17条 + dao_stdout.txt 143-192行):模型给
// `fasttext supervised -dim 100 -epoch 25 ...` 这条 exec_shell 调用自己设了 timeout=600000
// (10分钟),命令在 35.5% 进度时被这个自设的短 timeout 杀掉。模型事后自己算出真实训练要
// ~50分钟(在当时 3600s=60分钟总预算内完全够),但没有重新发起"不设短timeout、真的跑够
// 50分钟"这个调用,而是退到更小更快但精度不够(0.535)的配置。
//
// 这份数据早于 dc3009f(2026-07-22,去掉整个 exec_shell 前台 timeout 机制)。本脚本验证:
// 用当前(已含 dc3009f)代码的 buildSystemPrompt() + 当前 exec_shell 工具 schema(已经没有
// timeout 参数),把模型带到同一个决策点(已知训练要~50分钟,预算60分钟够用,数据已准备好),
// 问它"接下来怎么调用",看它会不会选一个不会被腰斩、真能跑完的方式。
//
// 不追求逐字节还原历史 tool 结果(没有 state.json 存档),前置上下文用真实已知事实压缩描述,
// 决策点前的模型自己那段真实推理原文(dao_stdout.txt 143-157行)逐字保留。
//
// 跑法: VOLCENGINE_API_KEY=... npx tsx scripts/verify-train-fasttext-timeout-replay.ts
import { streamChat } from "../src/client/client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { execShellTool } from "../src/tools/exec_shell.js";
import { execShellPollTool } from "../src/tools/exec_shell_poll.js";
import { execShellKillTool } from "../src/tools/exec_shell_kill.js";
import { readFileTool } from "../src/tools/read_file.js";
import { listDirTool } from "../src/tools/list_dir.js";
import { writeFileTool } from "../src/tools/write_file.js";
import { todoWriteTool } from "../src/tools/todo_write.js";
import { buildSystemPrompt } from "../src/prompt/system_prompt.js";
import type { ChatMessage, ToolCall } from "../src/client/types.js";

const apiKey = process.env.VOLCENGINE_API_KEY ?? "";
const baseUrl = "https://ark.cn-beijing.volces.com/api/coding/v3";
const model = "deepseek-v4-pro";
if (!apiKey) { console.error("需要 VOLCENGINE_API_KEY。"); process.exit(1); }

const toolList = [
  execShellTool, execShellPollTool, execShellKillTool,
  readFileTool, listDirTool, writeFileTool, todoWriteTool,
];
const registry = new ToolRegistry();
for (const t of toolList) registry.register(t);
const tools = registry.toApiTools(undefined, "zh");

const systemPrompt = buildSystemPrompt({
  modelId: model,
  toolSummaries: toolList.map((t) => `- ${t.name}: ${t.description}`).join("\n"),
  cwd: "/app",
  platform: "linux",
  lang: "zh",
  interactive: false, // headless/--eval,跟 harbor 真实场景一致
});

const REAL_TASK =
  `Please train a fasttext model on the yelp data in the data/ folder.\n\n` +
  `The final model size needs to be less than 150MB but get at least 0.62 accuracy on a private test set that comes from the same yelp review distribution.\n\n` +
  `The model should be saved as /app/model.bin\n`;

// 前置上下文:用真实发生过的 tool_call/tool_result 对(不是叙述性总结)重建,让模型当成
// "自己已经做过这些"而不是需要重新核实的模糊描述。具体数值(行数等)是历史真实值的近似
// (没有 state.json 存档做到逐字节还原),不影响"决策点这一步会不会设 timeout"这个机制验证。
let callId = 0;
const nextId = () => `call_${++callId}`;
function toolPair(name: string, args: Record<string, unknown>, result: string): ChatMessage[] {
  const id = nextId();
  return [
    { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
    { role: "tool", tool_call_id: id, content: result },
  ];
}

// 决策点前模型自己的真实推理原文(dao_stdout.txt 143-157行,逐字保留,只做必要的行内格式清理):
const REAL_REASONING_BEFORE_DECISION =
  `For model size < 150 MB, I need to control -dim and use quantization.\n\n` +
  `Let me start with a reasonable baseline and then adjust.\n\n` +
  `Typical good parameters for text classification:\n` +
  `- dim=100, epoch=25, lr=0.5, wordNgrams=2, minCount=1\n\n` +
  `But with 650k samples and 5 classes, I need enough capacity. Let me try a few combinations.\n\n` +
  `Actually, fastText models can be quantized to drastically reduce size. The quantize command reduces model size significantly while maintaining accuracy.\n\n` +
  `Let me first train a model and check its accuracy and size, then iterate.\n\n` +
  `Let me start with:\n` +
  `- dim=100, epoch=5, lr=0.5, wordNgrams=2, minCount=2\n\n` +
  `Let me start training.`;

const messages: ChatMessage[] = [
  { role: "system", content: systemPrompt },
  { role: "user", content: REAL_TASK },
  ...toolPair("exec_shell", { command: "ls /app/data" }, "test-00000-of-00001.parquet\ntrain-00000-of-00001.parquet"),
  ...toolPair("exec_shell", { command: "python3 -c \"import pandas as pd; df=pd.read_parquet('data/train-00000-of-00001.parquet'); print(df.shape); print(df['label'].nunique())\"" }, "(646685, 2)\n5"),
  ...toolPair("exec_shell", { command: "which fasttext || (apt-get update && apt-get install -y python3-fasttext fasttext)" }, "/usr/bin/fasttext"),
  ...toolPair("exec_shell", { command: "python3 -c \"import pandas as pd\\ndf = pd.read_parquet('data/train-00000-of-00001.parquet')\\nwith open('train.txt','w') as f:\\n    for _, r in df.iterrows():\\n        f.write(f'__label__{r.label} {r.text}\\\\n')\\nprint('wrote', len(df), 'lines')\"" }, "wrote 646685 lines"),
  ...toolPair("exec_shell", { command: "wc -l train.txt valid.txt" }, "  646685 train.txt\n   50000 valid.txt\n  696685 total"),
  { role: "assistant", content: REAL_REASONING_BEFORE_DECISION },
];

async function complete(msgs: ChatMessage[]) {
  const gen = streamChat({ baseUrl, apiKey, provider: "volcengine", model, messages: msgs, tools });
  let result;
  while (true) {
    const { value, done } = await gen.next();
    if (done) { result = value; break; }
  }
  return result;
}

function describeCall(tc: ToolCall): string {
  return `${tc.function.name}(${tc.function.arguments})`;
}

console.error("[verify] 复盘 train-fasttext 真实卡点:模型已经决定用 dim=100/epoch=25 等配置训练,\n" +
  "         现在问它接下来会怎么调用(当前 exec_shell 已经没有 timeout 参数)…\n");

let step1 = await complete(messages);
console.log("=== 第 1 次补全结果 ===");
console.log("content:", step1.content);
for (const tc of step1.tool_calls ?? []) console.log(`  tool_call: ${describeCall(tc)}`);

// 模型可能先做健全性检查(如 head train.txt)才发起真正的训练命令——真实回放需要跟进几轮,
// 不能只看第一次补全就下结论。最多跟进 4 轮,直到出现一个"看起来会长时间运行"的训练类调用
// (命令里出现 fasttext supervised)或轮数用尽。
let rounds = 0;
while (rounds < 4) {
  const tc = (step1.tool_calls ?? [])[0];
  if (!tc) break;
  const isTrainCall = (tc.function.name === "exec_shell" || tc.function.name === "Bash") &&
    /fasttext\s+supervised/.test(tc.function.arguments);
  if (isTrainCall) break;
  // 用一个合理、真实可信的占位结果继续对话(不是要验证 fasttext 输出本身,只是把模型推进到
  // 它自己愿意发起训练命令的那一步)。
  const placeholderResult = tc.function.name.match(/exec_shell|Bash/)
    ? "__label__3 Great food and service, will come back again.\n__label__1 Terrible experience, would not recommend."
    : "ok";
  messages.push({ role: "assistant", content: step1.content, tool_calls: step1.tool_calls });
  messages.push({ role: "tool", tool_call_id: tc.id, content: placeholderResult });
  step1 = await complete(messages);
  rounds++;
  console.log(`\n=== 第 ${rounds + 1} 次补全结果 ===`);
  console.log("content:", step1.content);
  for (const t of step1.tool_calls ?? []) console.log(`  tool_call: ${describeCall(t)}`);
}

const execCall = (step1.tool_calls ?? []).find(
  (t) => t.function.name === "exec_shell" || t.function.name === "Bash",
);

console.log("\n最终判读:");
if (!execCall) {
  console.log("❌ 没有调用命令执行类工具,无法判断——如实报告。");
  process.exit(0);
}
const args = JSON.parse(execCall.function.arguments) as Record<string, unknown>;
const hasTimeout = "timeout" in args;
const isBackground = args.background === true || args.run_in_background === true;
console.log(`调用: ${describeCall(execCall)}`);
console.log(`- 是否带 timeout 参数: ${hasTimeout ? "是(不应该——当前 schema 已经没有这个字段)" : "否(符合预期,schema 里已经没有 timeout 参数)"}`);
console.log(`- 是否选择后台执行: ${isBackground ? "是" : "否(前台执行——现在没有 timeout,会跑到自然结束,不会被腰斩)"}`);
console.log(
  hasTimeout
    ? "\n⚠️ 异常:模型给一个不存在的字段传了 timeout,需要进一步核实(可能是幻觉调用,实际不会生效)。"
    : "\n✅ 机制层面确认:模型不再能设置会腰斩训练的短 timeout。",
);
