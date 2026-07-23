// 第二步:内省诊断——train-fasttext 新卡点:两次真实运行里,模型从头到尾都假设
// "embedding 维度(dim)越大精度越好,得在 dim/bucket/minCount/quantize 之间小心平衡
// 控制体积",试的都是 dim=50~100,从未尝试过极小的 dim。但官方参考解法只用一条命令:
// `fasttext supervised -input train.txt -output model -wordNgrams 2 -dim 5`——
// dim=5,其它全默认,不量化不调 bucket,足以同时满足精度≥0.62 和体积<150MB。
//
// 本脚本把模型自己真实说过的"size math"推理(dao_stdout.txt 225-238行左右,dim=50下的
// 体积估算)喂回去,问它:如果只用 dim=5 会怎样,为什么没往这个方向想。
//
// 跑法: VOLCENGINE_API_KEY=... npx tsx scripts/verify-fasttext-dim-introspect.ts
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

// 真实推理原文(逐字保留,verify-0723 run,dim=50 时的体积估算):
const REAL_REASONING =
  `Let me think about model size more carefully:\n` +
  `- The model size is mainly: input matrix (vocab_size x dim) + output matrix (num_classes x dim) + ngram embeddings\n` +
  `- With dim=100, vocab of ~200k, the input matrix alone is 200k x 100 x 4 bytes = 80MB\n` +
  `- With bucket (for word n-grams), that adds bucket x dim x 4 bytes\n` +
  `- So we need to be careful with dim and bucket\n\n` +
  `Let me try: dim=50, epoch=10, wordNgrams=2, minCount=5, bucket=500000\n` +
  `That should give a model size roughly: vocab*50*4 + 5*50*4 + 500000*50*4 ≈ moderate`;

const REAL_TASK =
  `Please train a fasttext model on the yelp data in the data/ folder.\n\n` +
  `The final model size needs to be less than 150MB but get at least 0.62 accuracy on a private test set that comes from the same yelp review distribution.\n\n` +
  `The model should be saved as /app/model.bin\n`;

const INTROSPECTION_PROMPT =
  `以下是你自己在另一次真实任务里生成的推理原文(逐字保留):\n\n"""\n${REAL_REASONING}\n"""\n\n` +
  `事实核对:这次任务(以及另一次独立真实运行)里,你后续尝试的 dim 取值范围一直是 50~100,` +
  `从未尝试过更小的值。但这道题官方的参考解法(已验证能通过)只有一条命令:\n\n` +
  `fasttext supervised -input train.txt -output model -wordNgrams 2 -dim 5\n\n` +
  `dim=5,其它参数全部用默认值,没有量化、没有调 bucket/minCount。这个极简配置同时满足了` +
  `精度≥0.62 和体积<150MB 两个要求。\n\n` +
  `请客观复盘(不是自我辩护):\n` +
  `1. 你在上面那段推理里,思路是"dim 越大, 表达能力越强, 精度可能越好, 但体积会跟着涨,` +
  `需要在两者之间找平衡点"。看到 dim=5 这个官方答案后,你现在怎么评估这个假设——` +
  `对于"5分类的情感/主题分类"这类任务,dim 大小和分类精度之间的真实关系是什么?你之前的` +
  `假设错在哪?\n` +
  `2. 你有没有在决策过程中的任何一刻,认真考虑过"尝试一个远比默认值(100)小得多的 dim,` +
  `比如个位数"这个选项?如果没有,是因为你觉得这样"直觉上不像是个正经方案"而没有认真评估,` +
  `还是别的原因?\n` +
  `3. 如果要加一条系统提示词层面的引导,让你在类似"多个超参数联合影响一个指标,而你对其中` +
  `某个参数的边际效应不确定"的场景里,更愿意去试一下参数空间里看起来"不合常理"的极端值` +
  `(而不是只在"看起来合理"的中间地带反复微调),你会加哪句话?`;

const messages: ChatMessage[] = [
  { role: "system", content: systemPrompt },
  { role: "user", content: REAL_TASK },
  { role: "assistant", content: REAL_REASONING },
  { role: "user", content: INTROSPECTION_PROMPT },
];

const gen = streamChat({ baseUrl, apiKey, provider: "volcengine", model, messages, tools: [] });
let result;
while (true) {
  const { value, done } = await gen.next();
  if (done) { result = value; break; }
}
console.log(result.content);
