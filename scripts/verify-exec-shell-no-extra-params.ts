// 第三步:快速验证(不改 src/ 下真实代码)——测试内省诊断里模型自己提出的候选措辞:
// 在 exec_shell 描述末尾加一句"只使用列出的参数,不要添加任何额外字段",看同一个真实
// 决策点(train-fasttext 快速验证里模型自己生成过 "timeout": 300 的那个上下文)下,
// 模型是否还会加这个不存在的字段。
//
// 对照组(baseline,当前真实描述,不改)vs 实验组(描述末尾追加候选措辞),各跑 3 次
// 独立采样,看频率有没有实质性下降——不是跑一次就下结论。
//
// 跑法: VOLCENGINE_API_KEY=... npx tsx scripts/verify-exec-shell-no-extra-params.ts
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
import type { ChatMessage, ApiTool, ToolCall } from "../src/client/types.js";

const apiKey = process.env.VOLCENGINE_API_KEY ?? "";
const baseUrl = "https://ark.cn-beijing.volces.com/api/coding/v3";
const model = "deepseek-v4-pro";
if (!apiKey) { console.error("需要 VOLCENGINE_API_KEY。"); process.exit(1); }

// 候选措辞(内省诊断里模型自己提出的版本,略作精简):
const CANDIDATE_APPENDIX =
  "\n只使用上面列出的参数(command/description/background/dangerouslyDisableSandbox),不要添加任何未列出的额外字段" +
  "(即使你觉得它可能有用,比如 timeout)——额外字段不会生效,只会造成困惑。";

const toolList = [
  execShellTool, execShellPollTool, execShellKillTool,
  readFileTool, listDirTool, writeFileTool, todoWriteTool,
];

function buildTools(withCandidate: boolean): ApiTool[] {
  const registry = new ToolRegistry();
  for (const t of toolList) registry.register(t);
  const tools = registry.toApiTools(undefined, "zh");
  if (!withCandidate) return tools;
  return tools.map((t) =>
    t.function.name === execShellTool.name
      ? { ...t, function: { ...t.function, description: t.function.description + CANDIDATE_APPENDIX } }
      : t,
  );
}

function buildMessages(withCandidate: boolean): ChatMessage[] {
  const systemPrompt = buildSystemPrompt({
    modelId: model,
    toolSummaries: toolList
      .map((t) => `- ${t.name}: ${t.description}${t.name === execShellTool.name && withCandidate ? CANDIDATE_APPENDIX : ""}`)
      .join("\n"),
    cwd: "/app",
    platform: "linux",
    lang: "zh",
    interactive: false,
  });

  const REAL_TASK =
    `Please train a fasttext model on the yelp data in the data/ folder.\n\n` +
    `The final model size needs to be less than 150MB but get at least 0.62 accuracy on a private test set that comes from the same yelp review distribution.\n\n` +
    `The model should be saved as /app/model.bin\n`;

  let callId = 0;
  const nextId = () => `call_${++callId}`;
  function toolPair(name: string, args: Record<string, unknown>, result: string): ChatMessage[] {
    const id = nextId();
    return [
      { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
      { role: "tool", tool_call_id: id, content: result },
    ];
  }

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

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: REAL_TASK },
    ...toolPair("exec_shell", { command: "ls /app/data" }, "test-00000-of-00001.parquet\ntrain-00000-of-00001.parquet"),
    ...toolPair("exec_shell", { command: "python3 -c \"import pandas as pd; df=pd.read_parquet('data/train-00000-of-00001.parquet'); print(df.shape); print(df['label'].nunique())\"" }, "(646685, 2)\n5"),
    ...toolPair("exec_shell", { command: "which fasttext || (apt-get update && apt-get install -y python3-fasttext fasttext)" }, "/usr/bin/fasttext"),
    ...toolPair("exec_shell", { command: "python3 -c \"import pandas as pd\\ndf = pd.read_parquet('data/train-00000-of-00001.parquet')\\nwith open('train.txt','w') as f:\\n    for _, r in df.iterrows():\\n        f.write(f'__label__{r.label} {r.text}\\\\n')\\nprint('wrote', len(df), 'lines')\"" }, "wrote 646685 lines"),
    ...toolPair("exec_shell", { command: "wc -l train.txt valid.txt" }, "  646685 train.txt\n   50000 valid.txt\n  696685 total"),
    { role: "assistant", content: REAL_REASONING_BEFORE_DECISION },
  ];
}

async function complete(msgs: ChatMessage[], tools: ApiTool[]) {
  const gen = streamChat({ baseUrl, apiKey, provider: "volcengine", model, messages: msgs, tools });
  let result;
  while (true) {
    const { value, done } = await gen.next();
    if (done) { result = value; break; }
  }
  return result;
}

function hasSpuriousTimeout(tc: ToolCall | undefined): boolean {
  if (!tc) return false;
  try {
    const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
    return "timeout" in args;
  } catch { return false; }
}

async function sampleOnce(withCandidate: boolean): Promise<{ hasTimeout: boolean; call: string }> {
  const tools = buildTools(withCandidate);
  const messages = buildMessages(withCandidate);
  const step1 = await complete(messages, tools);
  const execCall = (step1.tool_calls ?? []).find((t) => t.function.name === "exec_shell" || t.function.name === "Bash");
  return { hasTimeout: hasSpuriousTimeout(execCall), call: execCall ? `${execCall.function.name}(${execCall.function.arguments})` : "(无 exec_shell 调用)" };
}

const N = 3;
for (const withCandidate of [false, true]) {
  console.log(`\n=== ${withCandidate ? "实验组(加候选措辞)" : "对照组(当前真实描述,不改)"} ===`);
  for (let i = 0; i < N; i++) {
    const r = await sampleOnce(withCandidate);
    console.log(`  第${i + 1}次: 带timeout字段=${r.hasTimeout ? "是" : "否"}  调用=${r.call.slice(0, 160)}`);
  }
}
