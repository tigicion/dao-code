// 关键前提检验:train-fasttext 的 dim=100 锚定,是这次会话上下文(读了数据规模、算过
// 体积公式之后)强化出来的,还是模型看到任务描述后的"冷启动"第一反应就已经是 dim=100/
// 更大,跟有没有上下文推理无关?
//
// 这决定了"派一个全新上下文的独立子代理重新提案"这个思路是否可能有效——如果冷启动
// (仅任务描述,没有任何前置探索/推理)已经是 dim=100,说明锚点来自预训练权重本身,
// 不是这次会话上下文强化的,那么"换一个新鲜上下文的子代理"不会规避这个锚点(子代理
// 用的是同一个底层模型,同样的预训练锚点仍在)。
//
// 跑法: VOLCENGINE_API_KEY=... npx tsx scripts/verify-cold-start-dim.ts
import { streamChat } from "../src/client/client.js";
import { buildSystemPrompt } from "../src/prompt/system_prompt.js";
import type { ChatMessage } from "../src/client/types.js";

const apiKey = process.env.VOLCENGINE_API_KEY ?? "";
const baseUrl = "https://ark.cn-beijing.volces.com/api/coding/v3";
const model = "deepseek-v4-pro";
if (!apiKey) { console.error("需要 VOLCENGINE_API_KEY。"); process.exit(1); }

const systemPrompt = buildSystemPrompt({
  modelId: model, toolSummaries: "- exec_shell: 在工作区执行 shell 命令",
  cwd: "/app", platform: "linux", lang: "zh", interactive: false,
});

const REAL_TASK =
  `Please train a fasttext model on the yelp data in the data/ folder.\n\n` +
  `The final model size needs to be less than 150MB but get at least 0.62 accuracy on a private test set that comes from the same yelp review distribution.\n\n` +
  `The model should be saved as /app/model.bin\n` +
  `(数据规模供参考,不用再去探测:约65万条训练样本,5分类,每条是一段Yelp评论文本。)\n\n` +
  `在真的开始跑任何命令之前,先只回答一个问题(不调用任何工具,纯文字回答):你打算先用` +
  `什么样的 fastText 训练参数(尤其是 -dim 取多少)做第一次尝试?为什么?`;

const messages: ChatMessage[] = [
  { role: "system", content: systemPrompt },
  { role: "user", content: REAL_TASK },
];

async function complete() {
  const gen = streamChat({ baseUrl, apiKey, provider: "volcengine", model, messages, tools: [] });
  let result;
  while (true) {
    const { value, done } = await gen.next();
    if (done) { result = value; break; }
  }
  return result;
}

const N = 6;
let smallCount = 0;
for (let i = 0; i < N; i++) {
  const result = await complete();
  const content = result.content ?? "";
  const m = content.match(/-dim[= ](\d+)/) ?? content.match(/dim\s*[=为是]\s*(\d+)/i) ?? content.match(/dim\s*(\d+)/i);
  const dim = m ? Number(m[1]) : null;
  const isSmall = dim !== null && dim <= 20;
  if (isSmall) smallCount++;
  console.log(`第${i + 1}次: dim=${dim ?? "未提及"} ${isSmall ? "✅极小值" : ""}`);
  console.log(`  摘要: ${content.replace(/\n/g, " ").slice(0, 200)}`);
}
console.log(`\n冷启动(无前置探索)提议极小 dim: ${smallCount}/${N}`);
