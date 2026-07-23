// 第三步:快速验证(不改 src/ 下真实代码)——train-fasttext 卡点:模型在决策点已知道
// autotune 存在(真实推理原文明确列出),却选择先手动训练几组自己猜的超参,直到约53分钟
// (60分钟预算)才真正用上 autotune(见 jobs/train-fasttext/verify-0723 真实数据)。
//
// 内省诊断(verify-train-fasttext-autotune-introspect.ts)结论:根因是系统提示词第108行
// "探查问题时优先用低成本的方式"这条规则,模型把"手动试一组自己熟悉的参数"错误估成低成本、
// 把"不熟悉的autotune"错误估成高成本,颠倒了两者真实成本(手动一轮5-10分钟 vs autotune一次
// 到位)。模型自己建议:任务有多重约束+工具自带自动搜索机制时,优先直接用该机制,不熟悉
// 参数不是回避的理由。
//
// 本脚本 A/B 对比:对照组(当前真实系统提示词,不改)vs 实验组(第108行后追加候选措辞),
// 用同一个真实决策点(dao_stdout.txt 145-179行原文,逐字保留)重放,看模型是否更倾向直接
// 调用/研究 autotune,而不是"let me just train a baseline"式手动试错。各采样3次。
//
// 跑法: VOLCENGINE_API_KEY=... npx tsx scripts/verify-autotune-preference.ts
import { streamChat } from "../src/client/client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { execShellTool } from "../src/tools/exec_shell.js";
import { readFileTool } from "../src/tools/read_file.js";
import { listDirTool } from "../src/tools/list_dir.js";
import { writeFileTool } from "../src/tools/write_file.js";
import { buildSystemPrompt } from "../src/prompt/system_prompt.js";
import type { ChatMessage } from "../src/client/types.js";

const apiKey = process.env.VOLCENGINE_API_KEY ?? "";
const baseUrl = "https://ark.cn-beijing.volces.com/api/coding/v3";
const model = "deepseek-v4-pro";
if (!apiKey) { console.error("需要 VOLCENGINE_API_KEY。"); process.exit(1); }

const toolList = [execShellTool, readFileTool, listDirTool, writeFileTool];
const registry = new ToolRegistry();
for (const t of toolList) registry.register(t);
const apiTools = registry.toApiTools(undefined, "zh");

// 候选措辞 v2(v1 两次快速验证均未绕开,改成更具体、指令式的措辞,直接点名"先查用法"这个
// 具体动作,而不是停留在"优先使用"这种偏抽象的建议层面):
const CANDIDATE_ADDITION =
  "具体例子:任务要求同时满足精度和体积/速度等多个指标时,如果所用工具本身带自动调参选项" +
  "(如 fastText 的 autotune、sklearn 的 GridSearchCV/RandomizedSearchCV 等),第一个动作" +
  "应该是去看这个选项怎么用(跑一次 --help 或搜一下参数),不是凭经验先手动挑一组参数训练" +
  "试试看——手动训练每一轮都要花几分钟到几十分钟,而查看自动调参选项的用法只要几十秒," +
  "'不熟悉这个选项的参数'不能成为跳过它、先手动试错的理由。";

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

// 真实推理原文(逐字保留,但截止在决策点【之前】——不包含"I'll start with a baseline"/
// "let me just train a baseline"这句真实发生过的决策本身。上一版重放把决策句也当成模型
// 已经说过的话塞进历史,等于让模型"续写自己已经承诺的计划"而不是重新做一次决策,这会掩盖
// 系统提示词新增措辞的真实效果——这是本轮第一次快速验证没绕开之后,回第二步重新审视发现的
// 设计缺陷,不是候选措辞本身被证伪,这次修正后重跑。
const REAL_REASONING =
  `fastText parameters that affect model size and accuracy:\n` +
  `- dim: vector dimension (default 100). Smaller dim = smaller model.\n` +
  `- epoch: number of epochs (default 5). More epochs = better accuracy but doesn't affect model size much.\n` +
  `- lr: learning rate\n` +
  `- wordNgrams: n-gram features (default 1). Using 2 gives bigram features which helps accuracy.\n` +
  `- bucket: number of buckets (default 2000000). Smaller bucket = smaller model.\n` +
  `- loss: loss function. For classification, softmax is default. ova (one-vs-all) could work for multi-class.\n` +
  `- minCount: minimal word count (default 1). Higher = fewer words stored = smaller model.\n` +
  `- minn and maxn: character n-gram lengths. These contribute to model size.\n` +
  `- autotune: fastText can auto-tune hyperparameters.\n\n` +
  `For model size control:\n` +
  `- The main contributors to model size are dim, bucket, and the vocabulary size.\n` +
  `- quantized models (.ftz) are much smaller but we need .bin.\n\n` +
  `Let me think about a reasonable strategy:\n` +
  `- 5 classes, 650k samples is a lot of data\n` +
  `- Need > 0.62 accuracy - this is a 5-class problem, random is 0.20, so 0.62 isn't too demanding\n` +
  `- 150MB model size limit`;

// 前置事实:真实发生过的环境探索 + 数据准备(用 tool_call/tool_result 对重建,不是叙述性总结,
// 让模型当成"自己已经做过这些"——同 verify-train-fasttext-timeout-replay.ts 的做法)。
let callId = 0;
const nextId = () => `call_${++callId}`;
function toolPair(name: string, args: Record<string, unknown>, result: string): ChatMessage[] {
  const id = nextId();
  return [
    { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
    { role: "tool", tool_call_id: id, content: result },
  ];
}

function buildMessages(candidate: boolean): { messages: ChatMessage[] } {
  return {
    messages: [
      { role: "system", content: systemPromptWith(candidate) },
      { role: "user", content: REAL_TASK },
      ...toolPair("exec_shell", { command: "ls /app/data" }, "test-00000-of-00001.parquet\ntrain-00000-of-00001.parquet"),
      ...toolPair("exec_shell", { command: "python3 -c \"import pandas as pd; df=pd.read_parquet('data/train-00000-of-00001.parquet'); print(df.shape); print(df['label'].nunique())\"" }, "(646685, 2)\n5"),
      ...toolPair("exec_shell", { command: "which fasttext || (apt-get update && apt-get install -y python3-fasttext fasttext)" }, "/usr/bin/fasttext"),
      ...toolPair("exec_shell", { command: "python3 -c \"import pandas as pd\\ndf = pd.read_parquet('data/train-00000-of-00001.parquet')\\nwith open('train.txt','w') as f:\\n    for _, r in df.iterrows():\\n        f.write(f'__label__{r.label} {r.text}\\\\n')\\nprint('wrote', len(df), 'lines')\"" }, "wrote 646685 lines"),
      ...toolPair("exec_shell", { command: "wc -l train.txt valid.txt" }, "  646685 train.txt\n   50000 valid.txt\n  696685 total"),
      { role: "assistant", content: REAL_REASONING },
    ],
  };
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

function choosesAutotuneFirst(content: string | null, toolCalls: { function: { name: string; arguments: string } }[] | undefined): boolean {
  const text = (content ?? "").toLowerCase();
  const callArgs = (toolCalls ?? []).map((t) => t.function.arguments.toLowerCase()).join(" ");
  const mentionsAutotuneInCall = /autotune/.test(callArgs);
  const mentionsManualTrainInCall = /fasttext supervised/.test(callArgs) && !/autotune/.test(callArgs);
  const mentionsAutotuneInText = /autotune/.test(text);
  // 判定"优先选autotune":要么直接调用就是 autotune 相关命令,要么调用前的文字明确说"先用/直接用
  // autotune"且没有先发起一个手动 fasttext supervised 训练调用。
  if (mentionsAutotuneInCall) return true;
  if (mentionsManualTrainInCall) return false;
  return mentionsAutotuneInText;
}

const N = 8;
for (const candidate of [false, true]) {
  console.log(`\n=== ${candidate ? "实验组(加候选措辞)" : "对照组(当前真实系统提示词)"} ===`);
  for (let i = 0; i < N; i++) {
    const { messages } = buildMessages(candidate);
    const result = await complete(messages);
    const picked = choosesAutotuneFirst(result.content, result.tool_calls);
    console.log(`  第${i + 1}次: 优先选autotune=${picked ? "是" : "否"}`);
    console.log(`    content: ${(result.content ?? "(无文字,直接调用工具)").replace(/\n/g, " ").slice(0, 160)}`);
    for (const tc of result.tool_calls ?? []) {
      console.log(`    tool_call: ${tc.function.name}(${tc.function.arguments.slice(0, 160)})`);
    }
  }
}
