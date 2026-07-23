// 第二步:内省诊断——train-fasttext 真实卡点:模型在决策点已经知道 fastText 有 autotune
// (真实推理原文里明确列出"autotune: fastText can auto-tune hyperparameters",甚至说出
// "Actually, let me use autotune or just train with reasonable params"),但最终选择先手动
// 训练几组自己猜的超参,直到约53分钟(60分钟预算)才真正用上 autotune——由 jobs/train-fasttext/
// verify-0723 真实数据确认(dao_stdout.txt 145-179行)。
//
// 本脚本把这段真实推理原样喂回给模型本身,问它当时为什么没有直接选 autotune。
//
// 跑法: VOLCENGINE_API_KEY=... npx tsx scripts/verify-train-fasttext-autotune-introspect.ts
import { streamChat } from "../src/client/client.js";
import { buildSystemPrompt } from "../src/prompt/system_prompt.js";
import type { ChatMessage } from "../src/client/types.js";

const apiKey = process.env.VOLCENGINE_API_KEY ?? "";
const baseUrl = "https://ark.cn-beijing.volces.com/api/coding/v3";
const model = "deepseek-v4-pro";
if (!apiKey) { console.error("需要 VOLCENGINE_API_KEY。"); process.exit(1); }

const systemPrompt = buildSystemPrompt({
  modelId: model,
  toolSummaries: "- exec_shell: 在工作区执行 shell 命令",
  cwd: "/app",
  platform: "linux",
  lang: "zh",
  interactive: false,
});

// 真实推理原文(dao_stdout.txt 145-179行,逐字保留):
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
  `- 150MB model size limit\n\n` +
  `I'll start with a baseline and iterate. Let me train with moderate parameters first.\n\n` +
  `Actually, let me think about model size more carefully:\n` +
  `- The model size is mainly: input matrix (vocab_size x dim) + output matrix (num_classes x dim) + ngram embeddings\n` +
  `- With dim=100, vocab of ~200k, the input matrix alone is 200k x 100 x 4 bytes = 80MB\n` +
  `- With bucket (for word n-grams), that adds bucket x dim x 4 bytes\n` +
  `- So we need to be careful with dim and bucket\n\n` +
  `Let me try: dim=50, epoch=10, wordNgrams=2, minCount=5, bucket=500000\n` +
  `That should give a model size roughly: vocab*50*4 + 5*50*4 + 500000*50*4 ≈ moderate\n\n` +
  `Let me just train a baseline and see.\n\n` +
  `Actually, let me use autotune or just train with reasonable params and check the size.`;

const REAL_TASK =
  `Please train a fasttext model on the yelp data in the data/ folder.\n\n` +
  `The final model size needs to be less than 150MB but get at least 0.62 accuracy on a private test set that comes from the same yelp review distribution.\n\n` +
  `The model should be saved as /app/model.bin\n`;

const INTROSPECTION_PROMPT =
  `以下是你自己在另一次真实任务里、在做出下一步动作前生成的推理原文(逐字保留,不是我编的):\n\n` +
  `"""\n${REAL_REASONING}\n"""\n\n` +
  `事实核对(已经用真实数据验证过):写完这段话之后,你接下来的动作是【手动】训练了一个自己猜的` +
  `配置(dim=50, epoch=10, wordNgrams=2, minCount=5, bucket=500000),然后又手动训练了另外两组` +
  `不同配置(dim=100+quantize、dim=50 epoch=30 wordNgrams=3),这几轮手动试错总共花了约28分钟。` +
  `直到用掉了60分钟预算里的约53分钟之后,你才真正调用了 fastText 的 autotune。autotune 一次性给出` +
  `的结果(0.6035)是你整个过程里最好的,比你手动试的所有配置都好。任务本身要求"精度≥0.62 且体积` +
  `<150MB"这种双重约束。\n\n` +
  `请客观复盘(不是自我辩护):\n` +
  `1. 你在上面这段推理里已经明确提到了"autotune",甚至说了"let me use autotune or just train ` +
  `with reasonable params"——这一刻你其实在两个选项之间做决定。为什么最终选了"手动训练基线"而不是` +
  `直接用 autotune?是没有意识到 autotune 更适合这种双重约束场景,还是别的原因?\n` +
  `2. autotune 是 fastText 专门设计用来处理"精度+体积双重约束"这类场景的功能,你当时对它的把握` +
  `程度够不够?是不是因为不熟悉具体怎么调用(参数、耗时、稳定性)而下意识回避了它,先用自己更熟悉的` +
  `手动训练"探路"?\n` +
  `3. 结合你现在能看到的完整系统提示词,有没有哪条具体措辞客观上鼓励了"先手动试、后用自动化工具"` +
  `这种顺序,而不是"任务有现成的自动化搜索工具时优先用它"?如果要加一条规则让你在类似场景里更早` +
  `选择 autotune 这类工具自带的自动搜索机制,你会加哪句话、加在系统提示词的哪个位置?`;

const messages: ChatMessage[] = [
  { role: "system", content: systemPrompt },
  { role: "user", content: REAL_TASK },
  { role: "assistant", content: `${REAL_REASONING}` },
  { role: "user", content: INTROSPECTION_PROMPT },
];

const gen = streamChat({ baseUrl, apiKey, provider: "volcengine", model, messages, tools: [] });
let result;
while (true) {
  const { value, done } = await gen.next();
  if (done) { result = value; break; }
}
console.log(result.content);
