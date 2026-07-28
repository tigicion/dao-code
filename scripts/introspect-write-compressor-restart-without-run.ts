// 内省诊断(debug-evolve 第二步):write-compressor 真实复测(retest-antistall-write-compressor-0727,
// commit 29c5139)撞见的卡点——line 2651 第一次写出 compress.rs 后,模型没有编译运行它,而是继续
// 纯文字推理算术编码器的边界情况(line 2653-2758,约100行),最终在【从未运行过第一版】的情况下
// 自己判断"思路不对",line 2760 决定重写,line 2762 发起第二次 Write 被 900s 超时打断。
//
// S/A/B:
//   S(已知信息,line 2651 那一刻):第一版 compress.rs 已经写到磁盘上,实现的就是刚描述的算法;
//     此前已经写出并验证过 analyze.c,能真实解码任意字节序列、显示 decomp 会产出什么——验证
//     compress.rs 输出能不能被 decomp 正确解码,只差一次编译+运行。
//   A(理想动作):编译并运行刚写的 compress.rs,喂给 decomp 看输出是否匹配 data.txt,拿到具体的
//     真实反馈(要么成功,要么是一个具体的、可定位的差异),而不是凭记忆重新推导整套算法。
//   B(实际动作):从未编译/运行过刚写的 compress.rs,转而在纯文字里把同一套编码器算法重新推导
//     了一遍(line 2657-2758 和写文件前 line 2640-2648 描述的算法基本重复),中途一度决定
//     "就实现它然后测试"(line 2746)却仍未落地测试,继续分析另一个简化方案(b=0)并【纯靠分析】
//     否决掉(line 2752,没有实际跑一次来验证这个否决对不对),最终决定"重新写一版更干净的"
//     (line 2758/2760),第二次 Write 被超时打断,整个 trial 没有任何可运行的交付物。
//
// 跑法: VOLCENGINE_API_KEY=... npx tsx scripts/introspect-write-compressor-restart-without-run.ts
import { promises as fs } from "node:fs";
import { streamChat } from "../src/client/client.js";
import type { ChatMessage } from "../src/client/types.js";

const apiKey = process.env.VOLCENGINE_API_KEY ?? "";
const baseUrl = "https://ark.cn-beijing.volces.com/api/coding/v3";
const model = "deepseek-v4-pro";
if (!apiKey) { console.error("需要 VOLCENGINE_API_KEY。"); process.exit(1); }

const STATE_PATH =
  "/Users/huaruoxu/ClaudeProject/dao-code/evals/terminal-bench/jobs/retest-antistall-write-compressor-0727/" +
  "write-compressor__q37SjPz/agent/dao_snapshot/.dao/sessions/20260727-152939-frdp/state.json";
const STDOUT_PATH =
  "/Users/huaruoxu/ClaudeProject/dao-code/evals/terminal-bench/jobs/retest-antistall-write-compressor-0727/" +
  "write-compressor__q37SjPz/agent/dao_stdout.txt";

const state = JSON.parse(await fs.readFile(STATE_PATH, "utf8")) as { messages: ChatMessage[] };
const realSystemPrompt = state.messages[0]!.content as string;
const realUserTask = state.messages[1]!.content as string;

const stdoutLines = (await fs.readFile(STDOUT_PATH, "utf8")).split("\n");
// line 2440-2762(1-indexed 文件行号,数组下标要 -1),即 S 建立到最终重写决定的完整片段。
const fragment = stdoutLines.slice(2439, 2762).join("\n");

async function complete(msgs: ChatMessage[]): Promise<string> {
  const gen = streamChat({ baseUrl, apiKey, provider: "volcengine", model, messages: msgs, extra: { reasoning_effort: "low" } });
  let result;
  while (true) {
    const { value, done } = await gen.next();
    if (done) { result = value; break; }
  }
  return typeof result.content === "string" ? result.content : JSON.stringify(result.content);
}

const messages: ChatMessage[] = [
  { role: "system", content: realSystemPrompt },
  { role: "user", content: realUserTask },
];

// 第0层:不给标准答案A,只给S(已有信息)和B(实际做的事/任务没完成这个事实)。
const layer0Question =
  "以下是你自己(同一个模型)在一次真实任务里产生的推理记录节选。这次任务最终没有做完——" +
  "900 秒预算耗尽时,你正在写第二版 compress.rs,但从未把它编译或运行过,data.comp 也从未生成。\n\n" +
  "--- 推理记录节选 ---\n" + fragment + "\n--- 节选结束 ---\n\n" +
  "客观分析:看这段你自己产生的记录,你当时为什么卡在这里、没能完成任务?";

console.error("[内省] 第0层(未见A)...");
messages.push({ role: "user", content: layer0Question });
const layer0Answer = await complete(messages);
console.log("=== 第0层回答 ===\n" + layer0Answer + "\n");
messages.push({ role: "assistant", content: layer0Answer });

// 第1层:揭示A,问是不是思路问题。
const layer1Question =
  "补充一个信息:在这段记录里(节选的开头附近),你已经写出了第一版 compress.rs,并且此前你自己" +
  "写过 analyze.c,能真实解码任意字节序列、显示 decomp 会产出什么——也就是说,验证刚写的" +
  "compress.rs 输出能不能被 decomp 正确解码,只差一次编译+运行(类似 `rustc compress.rs -o " +
  "compress && ./compress > data.comp && cat data.comp | ./decomp` 这样一条命令)。但你实际做的" +
  "是:从未运行过这第一版,转而在文字里把同一套编码器算法重新推导了一遍,最后决定重写。\n\n" +
  "是你当时没有意识到'编译运行一下就能拿到真实反馈'这个选项,还是别的原因?";

console.error("[内省] 第1层(揭示A)...");
messages.push({ role: "user", content: layer1Question });
const layer1Answer = await complete(messages);
console.log("=== 第1层回答 ===\n" + layer1Answer + "\n");
messages.push({ role: "assistant", content: layer1Answer });

// 第2层:如果模型认同该做A,问为什么卡住;引导它对照真实系统提示词原文。
const layer2Question =
  "如果你也认为当时应该先编译运行一下、而不是重新推导——当时是什么让你选择了'重新推导'而不是" +
  "'跑起来看看'?你现在能看到完整的系统提示词(这次对话开头那条 system 消息),里面有没有哪条" +
  "具体措辞客观上鼓励或允许了'继续推理/把方案想得更完善'而不是'先跑一次看真实反馈'?如果有," +
  "请引用原文的具体句子。如果重新走一遍,要调整哪一条指令/提醒的措辞才会让你在写完第一版之后" +
  "立刻选择编译运行,而不是继续在文字里推导?";

console.error("[内省] 第2层(追问机制)...");
messages.push({ role: "user", content: layer2Question });
const layer2Answer = await complete(messages);
console.log("=== 第2层回答 ===\n" + layer2Answer + "\n");

console.log("=== 完成 ===");
