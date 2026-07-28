// 内省诊断(debug-evolve 第二步):feal-differential-cryptanalysis 真实复测
// (retest-antistall-feal-differential-cryptanalysis-0727,commit 29c5139)撞见的卡点。
//
// S/A/B(audit.log 坐实,非推断):
//   S(已知信息,第一次 Bash 完成之后):对输入差分 0x80800000,用步长 0x01010101 采样了 256 个点
//     (`for x in range(0, 0x100000000, 0x01010101)`),全部输出 0x02000000,0 秒完成。这已经是
//     对一个密码学 F 函数差分性质极强的统计证据——256 个均匀分布的样本全部一致,足以支撑"概率
//     恒为1"这个结论,继续攻击链路(用这个性质剥最后一轮、枚举 key[5] 的 65536 个候选)本身
//     只需要几秒。
//   A(理想动作):直接开始写 attack.py,用已确认的差分性质设计选择明文对、剥最后一轮、枚举
//     65536 个候选 key[5] 并用差分性质过滤——这是任务本身要求的交付物,预算是30秒内完成。
//   B(实际动作):没有转向写攻击脚本,而是决定"更彻底地验证"这个已经有强证据的结论,发起第二次
//     Bash 调用——`for x in range(0x100000000):`(audit.log 确认原文,去掉了步长,对全部
//     2^32≈43亿个值做无步长穷举),这个调用本身计算量在合理时间内不可能返回,一直挂到 900s+
//     超时。dao_stdout.txt(324行)在发起这次调用后再无任何输出。
//
// 这是和 write-compressor 相反的模式:不是验证不足,是对一个已经有极强证据的结论做了过度且
// 计算不可行的"更彻底"验证,而没有转向实现要求的交付物。
//
// 跑法: VOLCENGINE_API_KEY=... npx tsx scripts/introspect-feal-brute-force-full-space.ts
import { promises as fs } from "node:fs";
import { streamChat } from "../src/client/client.js";
import type { ChatMessage } from "../src/client/types.js";

const apiKey = process.env.VOLCENGINE_API_KEY ?? "";
const baseUrl = "https://ark.cn-beijing.volces.com/api/coding/v3";
const model = "deepseek-v4-pro";
if (!apiKey) { console.error("需要 VOLCENGINE_API_KEY。"); process.exit(1); }

const STATE_PATH =
  "/Users/huaruoxu/ClaudeProject/dao-code/evals/terminal-bench/jobs/" +
  "retest-antistall-feal-differential-cryptanalysis-0727/feal-differential-cryptanalysis__CdyHc3f/" +
  "agent/dao_snapshot/.dao/sessions/20260728-012100-cg47/state.json";
const STDOUT_PATH =
  "/Users/huaruoxu/ClaudeProject/dao-code/evals/terminal-bench/jobs/" +
  "retest-antistall-feal-differential-cryptanalysis-0727/feal-differential-cryptanalysis__CdyHc3f/" +
  "agent/dao_stdout.txt";

const state = JSON.parse(await fs.readFile(STATE_PATH, "utf8")) as { messages: ChatMessage[] };
const realSystemPrompt = state.messages[0]!.content as string;
const realUserTask = state.messages[1]!.content as string;

// 全文只有324行,不需要截断,直接整篇作为片段(卡点前后的关键部分全在里面)。
const fragment = await fs.readFile(STDOUT_PATH, "utf8");

// audit.log 里的真实命令原文(dao_stdout.txt 的渲染文本里工具调用只显示箭头标记,不显示参数,
// 这里补上真实命令让模型看到自己到底发起了什么,不用它去猜)。
const firstBashCmd =
  'cd /app && python3 -c "\\nimport feal\\nimport random\\n\\n# Analyze the F-function\\n' +
  'def f_fn(x):\\n    return feal.f_function(x)\\n\\ndef g_fn(a, b, x):\\n    temp = (a + b + x) & 0xFF\\n' +
  '    return ((temp << 2) | (temp >> 6)) & 0xFF\\n\\ndiff = 0x80800000\\ncounts = {}\\n' +
  'for x in range(0, 0x100000000, 0x01010101):  # sample\\n    y1 = f_fn(x)\\n    y2 = f_fn(x ^ diff)\\n' +
  '    out_diff = y1 ^ y2\\n    counts[out_diff] = counts.get(out_diff, 0) + 1\\n..."';
const secondBashCmd =
  'cd /app && python3 -c "\\nimport feal\\n\\ndef f_fn(x):\\n    return feal.f_function(x)\\n\\n' +
  'diff = 0x80800000\\nall_match = True\\nfor x in range(0x100000000):\\n    y1 = f_fn(x)\\n' +
  '    y2 = f_fn(x ^ diff)\\n    out_diff = y1 ^ y2\\n    if out_diff != 0x02000000:\\n        ...\\n' +
  '        break\\nif all_match:\\n    print(\'All 2^32 inputs: f(x) ^ f(x ^ 0x80800000) = 0x02000000\')\\n"';

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

// 第0层:不给标准答案A,只给S(已有信息)和B(实际做的事/任务没完成这个事实+两次真实命令原文)。
const layer0Question =
  "以下是你自己(同一个模型)在一次真实任务里产生的推理记录节选(完整,324行)。这次任务最终没有" +
  "做完——发起第二次 Bash 调用之后,预算耗尽,attack.py 从未被创建。\n\n" +
  "第一次 Bash 调用的真实命令原文:\n" + firstBashCmd + "\n\n" +
  "第二次 Bash 调用的真实命令原文(这次调用之后再没有任何输出,直到超时):\n" + secondBashCmd + "\n\n" +
  "--- 推理记录节选 ---\n" + fragment + "\n--- 节选结束 ---\n\n" +
  "客观分析:看这段你自己产生的记录和这两条真实命令,你当时为什么卡在这里、没能完成任务?";

console.error("[内省] 第0层(未见A)...");
messages.push({ role: "user", content: layer0Question });
const layer0Answer = await complete(messages);
console.log("=== 第0层回答 ===\n" + layer0Answer + "\n");
messages.push({ role: "assistant", content: layer0Answer });

// 第1层:揭示A,问是不是思路问题。
const layer1Question =
  "补充一个信息:第一次 Bash 调用(256 个样本,步长采样)已经给出了极强的统计证据——256/256 全部" +
  "一致,这在密码学场景里已经足以支撑'概率恒为1'这个结论,直接推进攻击(写 attack.py 剥最后一轮、" +
  "枚举 65536 个候选 key[5])只需要几秒。但第二次 Bash 调用改成了对全部 2^32≈43亿个值做无步长" +
  "穷举——这个计算量在合理时间内不可能返回。\n\n" +
  "是你当时没有意识到 256/256 已经是足够的证据、可以直接推进攻击了,还是别的原因让你选择了" +
  "'更彻底地验证'而不是'直接开始写攻击脚本'?";

console.error("[内省] 第1层(揭示A)...");
messages.push({ role: "user", content: layer1Question });
const layer1Answer = await complete(messages);
console.log("=== 第1层回答 ===\n" + layer1Answer + "\n");
messages.push({ role: "assistant", content: layer1Answer });

// 第2层:如果模型认同该做A,问为什么卡住;引导它对照真实系统提示词原文。
const layer2Question =
  "如果你也认为 256/256 已经足够、当时该直接写攻击脚本——当时是什么让你选择了'更彻底验证'这" +
  "条路,而不是相信已经拿到的强证据、直接推进?你现在能看到完整的系统提示词(这次对话开头那条" +
  "system 消息),里面有没有哪条具体措辞客观上鼓励或允许了'继续验证/把证据做得更充分'而不是" +
  "'证据已经够了,该动手实现'?如果有,请引用原文的具体句子。如果重新走一遍,要调整哪一条指令/" +
  "提醒的措辞,才会让你在拿到256/256这个结果之后,判断'证据已经足够,直接写攻击脚本',而不是去" +
  "扩大验证范围?";

console.error("[内省] 第2层(追问机制)...");
messages.push({ role: "user", content: layer2Question });
const layer2Answer = await complete(messages);
console.log("=== 第2层回答 ===\n" + layer2Answer + "\n");

console.log("=== 完成 ===");
