// 第三步:快速验证(不改 src/ 下真实代码)——train-fasttext 新卡点:模型从未尝试过极小的
// dim 值(官方参考解法只用 dim=5 + wordNgrams=2 就通过),两次真实运行搜索范围一直是
// dim∈{50,80,100},从没检验过"dim 越大精度越好"这个假设本身。
//
// 内省诊断(verify-fasttext-dim-introspect.ts)结论:根因是把 dim 当成"体积代价"而非
// "假设空间大小",候选方案生成阶段就被这个直觉过滤掉了极端值,导致"验证"只发生在
// 已经被错误直觉筛过的候选上。模型自己提出候选规则:连续参数空间做微调式搜索时,先跳到
// 两端各试一次校准直觉。
//
// A/B 对比:对照组(当前真实系统提示词)vs 实验组(加候选措辞),用同一个真实决策点重放
// (dao_stdout.txt 里 dim=50 体积估算那段推理,逐字保留,决策点之前截断),看模型下一步
// 会不会真的去试一个极小的 dim。
//
// 跑法: VOLCENGINE_API_KEY=... npx tsx scripts/verify-extreme-value-probe.ts
import { streamChat } from "../src/client/client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { execShellTool } from "../src/tools/exec_shell.js";
import { readFileTool } from "../src/tools/read_file.js";
import { listDirTool } from "../src/tools/list_dir.js";
import { writeFileTool } from "../src/tools/write_file.js";
import { buildSystemPrompt } from "../src/prompt/system_prompt.js";
import type { ChatMessage, ApiTool } from "../src/client/types.js";

const apiKey = process.env.VOLCENGINE_API_KEY ?? "";
const baseUrl = "https://ark.cn-beijing.volces.com/api/coding/v3";
const model = "deepseek-v4-pro";
if (!apiKey) { console.error("需要 VOLCENGINE_API_KEY。"); process.exit(1); }

// 候选措辞 v2(v1 在真实重放里 0/11 未绕开,改成更具体、直接点名"默认值/教科书常见值"这个
// 具体心理锚点,而不是停留在"连续参数空间"这种抽象表述):
const CANDIDATE_ADDITION =
  "选择一个数值型超参数(如维度、层数、缓存大小)时,如果你倾向选的值就是这个参数的默认值或" +
  "教科书上的常见值,而不是根据这次任务的具体规模(比如类别数、数据量、体积上限)重新推导出来的," +
  "先快速试一次远小于这个默认值的极端值(比如默认的 1/10 甚至更小),看结果有没有明显变差——" +
  "任务规模越小,所需的参数往往比默认值/教科书值小得多,默认值是为更通用/更大规模的场景设计的。";

const toolList = [execShellTool, readFileTool, listDirTool, writeFileTool];
const registry = new ToolRegistry();
for (const t of toolList) registry.register(t);
const apiTools = registry.toApiTools(undefined, "zh");

function systemPromptWith(candidate: boolean): string {
  const base = buildSystemPrompt({
    modelId: model,
    toolSummaries: toolList.map((t) => `- ${t.name}: ${t.description}`).join("\n"),
    cwd: "/app",
    platform: "linux",
    lang: "zh",
    interactive: false,
  });
  if (!candidate) return base;
  const marker = "探查问题时优先用低成本的方式:先试耗时短、搜索空间小的方案,拿到结果后再决定是否加大投入。";
  const idx = base.indexOf(marker);
  if (idx === -1) throw new Error("没找到锚点句,系统提示词原文可能已变化,需要重新确认插入位置");
  const insertAt = idx + marker.length;
  return base.slice(0, insertAt) + CANDIDATE_ADDITION + base.slice(insertAt);
}

const REAL_TASK =
  `Please train a fasttext model on the yelp data in the data/ folder.\n\n` +
  `The final model size needs to be less than 150MB but get at least 0.62 accuracy on a private test set that comes from the same yelp review distribution.\n\n` +
  `The model should be saved as /app/model.bin\n`;

// 真实推理原文(逐字保留,截止在"决定具体试哪组dim"之前):
const REAL_REASONING =
  `Let me think about model size more carefully:\n` +
  `- The model size is mainly: input matrix (vocab_size x dim) + output matrix (num_classes x dim) + ngram embeddings\n` +
  `- With dim=100, vocab of ~200k, the input matrix alone is 200k x 100 x 4 bytes = 80MB\n` +
  `- With bucket (for word n-grams), that adds bucket x dim x 4 bytes\n` +
  `- So we need to be careful with dim and bucket`;

let callId = 0;
const nextId = () => `call_${++callId}`;
function toolPair(name: string, args: Record<string, unknown>, result: string): ChatMessage[] {
  const id = nextId();
  return [
    { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
    { role: "tool", tool_call_id: id, content: result },
  ];
}

function buildMessages(candidate: boolean): ChatMessage[] {
  return [
    { role: "system", content: systemPromptWith(candidate) },
    { role: "user", content: REAL_TASK },
    ...toolPair("exec_shell", { command: "ls /app/data" }, "test-00000-of-00001.parquet\ntrain-00000-of-00001.parquet"),
    ...toolPair("exec_shell", { command: "python3 -c \"import pandas as pd; df=pd.read_parquet('data/train-00000-of-00001.parquet'); print(df.shape); print(df['label'].nunique())\"" }, "(646685, 2)\n5"),
    ...toolPair("exec_shell", { command: "which fasttext || (apt-get update && apt-get install -y python3-fasttext fasttext)" }, "/usr/bin/fasttext"),
    ...toolPair("exec_shell", { command: "python3 -c \"import pandas as pd\\ndf = pd.read_parquet('data/train-00000-of-00001.parquet')\\nwith open('train.txt','w') as f:\\n    for _, r in df.iterrows():\\n        f.write(f'__label__{r.label} {r.text}\\\\n')\\nprint('wrote', len(df), 'lines')\"" }, "wrote 646685 lines"),
    ...toolPair("exec_shell", { command: "wc -l train.txt valid.txt" }, "  646685 train.txt\n   50000 valid.txt\n  696685 total"),
    { role: "assistant", content: REAL_REASONING },
  ];
}

async function complete(messages: ChatMessage[]) {
  const gen = streamChat({ baseUrl, apiKey, provider: "volcengine", model, messages, tools: apiTools });
  let result;
  while (true) {
    const { value, done } = await gen.next();
    if (done) { result = value; break; }
  }
  return result;
}

function extractDim(content: string | null, toolCalls: { function: { name: string; arguments: string } }[] | undefined): number | null {
  const text = (content ?? "") + " " + (toolCalls ?? []).map((t) => t.function.arguments).join(" ");
  const m = text.match(/-dim[= ](\d+)/) ?? text.match(/"dim"\s*:\s*(\d+)/) ?? text.match(/dim\s*=\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

const N = 8;
const EXTREME_THRESHOLD = 20; // 认为"试了极小值"的判定阈值(标准答案是5,给点余量)

for (const candidate of [false, true]) {
  console.log(`\n=== ${candidate ? "实验组(加候选措辞)" : "对照组(当前真实系统提示词)"} ===`);
  let extremeCount = 0;
  for (let i = 0; i < N; i++) {
    const messages = buildMessages(candidate);
    const result = await complete(messages);
    const dim = extractDim(result.content, result.tool_calls);
    const isExtreme = dim !== null && dim <= EXTREME_THRESHOLD;
    if (isExtreme) extremeCount++;
    console.log(`  第${i + 1}次: dim=${dim ?? "未提及"}  ${isExtreme ? "✅极小值" : ""}`);
    console.log(`    content: ${(result.content ?? "").replace(/\n/g, " ").slice(0, 200)}`);
    for (const tc of result.tool_calls ?? []) console.log(`    tool_call: ${tc.function.name}(${tc.function.arguments.slice(0, 150)})`);
  }
  console.log(`  → ${extremeCount}/${N} 试了 dim<=${EXTREME_THRESHOLD}`);
}
