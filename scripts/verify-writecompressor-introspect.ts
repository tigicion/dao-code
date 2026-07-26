// 第二步:内省诊断——write-compressor 深挖(archive/pre-round-0723/iter11-2048/
// write-compressor__ucztyRo)。900s自然超时,reward=0。此前已被评为"反复推理反模式"
// 家族第22例(与regex-chess/gpt2-codegolf/adaptive-rejection-sampler等本session已确认
// 22+样本的家族同型),历史深挖(evolution-log.md line2124)已精确定位:886s跨度内8次
// 工具调用,两段纯文字推导共758s(占86%),全文"Wait"51次/"Actually"99次/"Let me
// think"29次,138个markdown代码块全部是手算伪代码从未真正执行。
//
// 本例最具体的新卡点(此前样本未见的子类型):模型手上已经有一个能验证候选压缩数据是否
// 正确的现成oracle二进制(/app/decomp,已编译成功),两次明确提议要用它做实证验证,却都
// 在下一句自我否决退回纯手算:
//   第一次(约行1482):"Let me write a simple test...see what it outputs. But I don't
//   have compressed input..." → 放弃
//   第二次(约行2651-2748):"let me just write a test harness...compare." 紧接
//   "Hmm, but we don't have a compressor yet" → 又放弃
// 全程0次执行./decomp,包括对自己发现的关键疑点("buf数组未初始化")也放弃验证。
//
// 红线要求:即便和已知家族一模一样,仍需实际发起模型调用,不能凭历史印象跳过。本次
// 聚焦这个"有oracle却自我否决"的具体子模式(区别于adaptive-rejection-sampler的
// "宣布要写却不写"),用同批次sibling真实系统提示词+真实任务原文+推理节选三层追问。
//
// 跑法: VOLCENGINE_API_KEY=... npx tsx scripts/verify-writecompressor-introspect.ts
import { readFileSync } from "node:fs";
import { streamChat } from "../src/client/client.js";
import type { ChatMessage } from "../src/client/types.js";

const apiKey = process.env.VOLCENGINE_API_KEY ?? "";
const baseUrl = "https://ark.cn-beijing.volces.com/api/coding/v3";
const model = "deepseek-v4-pro";
if (!apiKey) { console.error("需要 VOLCENGINE_API_KEY。"); process.exit(1); }

const systemPrompt = readFileSync("/private/tmp/claude-503/-Users-huaruoxu-ClaudeProject-dao-code/cfb093b3-1cab-42f9-999c-8cecebc3ea4d/scratchpad/ars_sysprompt.txt", "utf-8");

const TASK_TEXT = `I have a decompressor in /app/decomp.c. It reads compressed data from stdin and writes the decompressed data to stdout. I also have a file /app/data.txt that has a bunch of text. Write me data.comp that's compressed such that running cat data.comp | /app/decomp gives exactly data.txt.`;

const REASONING_EXCERPT = `
(前段:约2次工具调用编译/查看/app/decomp.c源码成功,之后758秒/886秒总跨度纯文字推导,
逐位手推一个自定义LZ77类压缩格式的字面量编码范围、buf数组初始化状态等比特级细节,
全文"Wait"51次/"Actually"99次/"Hmm"30次/"Let me trace"14次/"Let me think"29次,
138个markdown代码块全是手算伪代码,没有一个被真正写入文件或执行)

【第一次提议用decomp做实证验证,约行1482】
"Let me write a simple test to encode a small string and decode it, see what it
outputs. But I don't have compressed input..."
(紧接着放弃这个思路,回到纯手算推导编码格式细节)

【第二次提议,约行2651-2748】
"OK let me just write a test harness that encodes a few bytes manually, run it through
decomp, and compare."
"Hmm, but we don't have a compressor yet, so I'd need to hand-craft the compressed bytes
based on my understanding of the format..."
(又放弃了这个思路,继续手推格式细节)

【全程】/app/decomp 从第2次工具调用后再未被执行过一次(0次实际调用),即便模型自己中途
发现了一个关键疑点("buf数组似乎未初始化,可能影响解码结果")也没有写一个脚本去验证
这个疑点,而是继续手推。

【会话结局】900s硬超时打断纯文字推导,data.comp从未被创建。
`;

async function ask(messages: ChatMessage[], userText: string): Promise<string> {
  messages.push({ role: "user", content: userText });
  const gen = streamChat({ baseUrl, apiKey, provider: "volcengine", model, messages, tools: [] });
  let result;
  while (true) {
    const { value, done } = await gen.next();
    if (done) { result = value; break; }
  }
  messages.push({ role: "assistant", content: result.content });
  return result.content;
}

async function main() {
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `以下是任务原文(供你回忆背景,不是要你现在执行):\n\n${TASK_TEXT}` },
  ];

  const layer0 = await ask(messages,
    `以下是你自己(同一个模型)在另一次独立会话里,针对上面这道题产生的真实推理和工具调用记录` +
    `(不是我编的,原样节选):\n${REASONING_EXCERPT}\n\n` +
    `事实:这次会话因900秒超时自然结束,data.comp从未被创建,任务没有完成。你手上其实一直有` +
    `一个现成的验证工具(/app/decomp,已编译成功),但整场会话只执行过它2次(用于查看源码/` +
    `编译),此后758秒纯手算,0次真正用它验证任何候选压缩字节串。你自己两次明确提议要写一个` +
    `test harness用decomp做实证验证,但都在提议后的下一句立刻自我否决、退回纯手算。\n\n` +
    `请客观复盘:你当时为什么在手上有现成验证工具、自己也两次提议要用它的情况下,两次都` +
    `没有真的去用它?`);
  console.log("\n=== 层0(未见标准答案) ===\n" + layer0);

  const layer1 = await ask(messages,
    `补充一个视角:你两次自我否决的理由都是"我还没有一份已知正确的压缩数据可以测试"——` +
    `第一次是"But I don't have compressed input",第二次是"we don't have a compressor` +
    `yet"。但理想动作(A)其实很直接:decomp本身就是"压缩格式→解压结果"这个方向的oracle,` +
    `不需要先有一个"正确的压缩器"才能用它——你可以手工构造任意一段你猜测格式正确的字节串` +
    `(哪怕是根据当前推导的假设编的几个字节),直接跑一遍"echo -ne '你猜的字节' | /app/decomp"` +
    `,看真实输出是不是你预期的内容,用真实结果来验证/证伪你当前的格式假设,而不是在脑子里` +
    `继续假设"这个字段应该是这样编码"。这正是"验证需要预先构造一个完整正确答案"和"验证` +
    `只需要一个具体的可测试假设"这两者之间的混淆。\n\n` +
    `是你当时没有意识到decomp本身就能单独拿来试探式验证局部假设(不需要先有完整正确答案),` +
    `还是别的原因?`);
  console.log("\n=== 层1(揭示A) ===\n" + layer1);

  const layer2 = await ask(messages,
    `如果你认同当时应该用decomp做试探式验证——那当时是什么让你把"我需要用decomp验证"这个` +
    `正确的冲动,连续两次都用"但我还没有一份正确的压缩数据"这个理由否决掉?这是不是和你在` +
    `其它类似任务里表现出的"倾向于要求一个完整、确信正确的输入才敢执行验证,而不是用` +
    `验证结果本身来倒推哪部分假设是错的"这个思维定势是同一回事?\n\n` +
    `结合你现在能看到的完整系统提示词,有没有具体条款客观上助长了"必须先想清楚整个方案` +
    `再验证"而不是"用最小可执行的探测直接验证局部假设"这种倾向?你认为这个具体错误` +
    `(把decomp当'终审',而不是当'可以随时低成本调用的信息源'),是通用的` +
    `文字提示词大概率能修正的思维方式,还是这类会话里反复出现、对提示词提醒有实证抵抗力` +
    `的固有模式?请给出你的真实判断,不用为了配合我的问题硬给一个能写进提示词的方案。`);
  console.log("\n=== 层2(追问原因) ===\n" + layer2);
}

await main();
