// 第二步:内省诊断——train-fasttext 快速验证里,模型在 exec_shell(Bash)已经没有
// timeout 参数(schema 无此字段、additionalProperties:false、描述明确写"没有超时机制")
// 的情况下,仍然在调用参数里自己加了一个 timeout 字段(实测中 300/600/900 各出现过一次,
// 且用 execShellTool.schema.parse() 验证过这个字段会被 zod 静默剥离、handler 收不到)。
//
// 本脚本不猜,直接把这次真实生成的调用(不用 Monitor 工具是否在场做前提——上一轮重放里
// Monitor 根本没注册,模型依然加了 timeout,所以"看到 Monitor 才学"这个假设未必成立)
// 喂回给模型本身,用第三方复盘框架问它:当时为什么加了这个字段,是不是被 Monitor 的
// 参数惯例带偏了,以及要怎么改工具描述才能让它不再这么做。
//
// 跑法: VOLCENGINE_API_KEY=... npx tsx scripts/verify-exec-shell-timeout-introspect.ts
import { streamChat } from "../src/client/client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { execShellTool } from "../src/tools/exec_shell.js";
import { monitorTool } from "../src/tools/monitor.js";
import { buildSystemPrompt } from "../src/prompt/system_prompt.js";
import type { ChatMessage } from "../src/client/types.js";

const apiKey = process.env.VOLCENGINE_API_KEY ?? "";
const baseUrl = "https://ark.cn-beijing.volces.com/api/coding/v3";
const model = "deepseek-v4-pro";
if (!apiKey) { console.error("需要 VOLCENGINE_API_KEY。"); process.exit(1); }

// 两种场景对照:A 只有 exec_shell(跟上一轮重放条件一致,排除 Monitor 影响);
// B 额外注册 Monitor(还原真实 harbor 环境里的完整工具集)。两种都做内省诊断,
// 分别看模型怎么解释,不预设哪个是"真正原因"。
async function run(label: string, withMonitor: boolean) {
  const toolList = withMonitor
    ? [execShellTool, monitorTool]
    : [execShellTool];
  const registry = new ToolRegistry();
  for (const t of toolList) registry.register(t);
  const tools = registry.toApiTools(undefined, "zh");

  const systemPrompt = buildSystemPrompt({
    modelId: model,
    toolSummaries: toolList.map((t) => `- ${t.name}: ${t.description}`).join("\n"),
    cwd: "/app",
    platform: "linux",
    lang: "zh",
    interactive: false,
  });

  // 真实发生过的那次调用(train-fasttext 快速验证里,模型自己生成的原始参数,逐字保留):
  const REAL_CALL = `{"command": "fasttext supervised -input train.txt -output model_baseline -dim 100 -epoch 15 -lr 0.5 -wordNgrams 2 -minCount 2 -loss softmax 2>&1 | tail -5", "description": "Train baseline fastText model", "timeout": 300}`;

  const INTROSPECTION_PROMPT =
    `以下是你自己刚才在另一次对话里生成的一次真实工具调用(不是我编的):\n\n` +
    `工具名:exec_shell (对模型显示为 Bash)\n` +
    `参数:${REAL_CALL}\n\n` +
    `事实核对(已经用代码验证过):这个工具的 JSON Schema 里根本没有 timeout 这个字段` +
    `(只有 command/description/background/dangerouslyDisableSandbox 四个字段),` +
    `schema 还声明了 additionalProperties:false。工具描述原文也明确写着"前台没有任何超时机制"。` +
    `但你依然在参数里自己加了 "timeout": 300 这个不存在的字段。\n\n` +
    `请客观分析(不是自我辩护,是复盘):\n` +
    `1. 你当时为什么会生成一个 schema 里根本没有的字段?是没注意到 schema 只有那四个字段,` +
    `还是即便注意到了也觉得"加上应该没坏处"?\n` +
    `2. 你现在能看到的工具集里,Monitor 这个工具有一个真实存在的 timeout_ms 参数,` +
    `command 字段描述也跟 exec_shell 很像("shell 命令/脚本")。这次生成 timeout 字段,` +
    `有没有可能是把 Monitor 的调用惯例带到了 exec_shell 上?如果这次的工具集里根本` +
    `没有 Monitor,你觉得自己还会不会加这个字段?\n` +
    `3. 结合你现在能看到的完整系统提示词和 exec_shell 描述原文,有没有哪条具体措辞的缺失` +
    `或含糊,客观上没能阻止你加这个字段?如果要改一句话让你不再这么做,你会加哪句、加在` +
    `哪里(系统提示词里,还是 exec_shell 的工具描述里)?`;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: INTROSPECTION_PROMPT },
  ];

  const gen = streamChat({ baseUrl, apiKey, provider: "volcengine", model, messages, tools: [] });
  let result;
  while (true) {
    const { value, done } = await gen.next();
    if (done) { result = value; break; }
  }
  console.log(`\n=== ${label} ===`);
  console.log(result.content);
}

await run("场景A:只有 exec_shell(排除 Monitor 影响)", false);
await run("场景B:exec_shell + Monitor(还原真实完整工具集)", true);
