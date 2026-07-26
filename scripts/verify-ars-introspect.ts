// 第二步:内省诊断——adaptive-rejection-sampler 深挖(archive/pre-round-0723/heldout-check7/
// adaptive-rejection-sampler__sEiqWCW)。900s自然超时,reward=0,仅2次工具调用(t=0/t=3.4s,
// 均exec_shell,之后再无任何工具调用,含0次Write),4073行dao_stdout全程在同一个巨型
// 推理回合里。全文出现34次"Let me write the code (now)"这类明确宣布要写代码的句子,
// 但从头到尾没有一次真正调用Write。这是已确认"reasoning不收敛"家族(同regex-chess/
// gpt2-codegolf等9题,已用5种候选累计0/15命中率、判定abandoned)的疑似第10个样本,
// 且本例的"说要写但不写"次数(34次)比已记录的样本更极端。
//
// 红线要求:即便看着和已知家族一模一样,仍必须实际发起本节模型调用,不能凭历史印象
// 直接判定。
//
// 跑法: VOLCENGINE_API_KEY=... npx tsx scripts/verify-ars-introspect.ts
import { readFileSync } from "node:fs";
import { streamChat } from "../src/client/client.js";
import type { ChatMessage } from "../src/client/types.js";

const apiKey = process.env.VOLCENGINE_API_KEY ?? "";
const baseUrl = "https://ark.cn-beijing.volces.com/api/coding/v3";
const model = "deepseek-v4-pro";
if (!apiKey) { console.error("需要 VOLCENGINE_API_KEY。"); process.exit(1); }

const systemPrompt = readFileSync("/private/tmp/claude-503/-Users-huaruoxu-ClaudeProject-dao-code/cfb093b3-1cab-42f9-999c-8cecebc3ea4d/scratchpad/ars_sysprompt.txt", "utf-8");
const taskText = readFileSync("/private/tmp/claude-503/-Users-huaruoxu-ClaudeProject-dao-code/cfb093b3-1cab-42f9-999c-8cecebc3ea4d/scratchpad/ars_task.txt", "utf-8");

const REASONING_EXCERPT = `
【t=0s, t=3.4s:仅有的两次工具调用】exec_shell(安装/检查R环境),此后全程(约896秒)
再无任何工具调用,只有连续的推理文字。

【推理原文节选,按顺序摘录出现"宣布要写代码"的原句(全文共出现34次这类句子,
逐条摘录前几条+穿插的分析内容片段)】

(前段:约250行详细推导ARS算法数学原理——切线交点公式、分段指数包络采样、
数值稳定性考虑,内容正确且专业)

"OK let me now write the full code. I'll be thorough."
(...继续约30行推导对数密度数值导数、边界条件处理...)
"OK, I think I have a solid understanding. Let me write the code now."
(...继续约30行讨论如何处理非log-concave检测、模块划分...)
"OK, enough analysis. Let me write the code."
(...继续讨论测试用例设计、KS检验统计量...)
"Let me write the full ars.R file."
"Let me write the code now and be careful about all the edge cases."
(...继续约20行讨论数值溢出防护...)
"Let me write it all now."
"OK, I have enough understanding. Let me write the code."
(...继续约60行推导下包络chord公式、处理z交点乱序的边界情况...)
"OK, enough planning. Let me write the code."
"Let me finalize the code. I'll write it section by section."
"Let me write the code now."
"OK, I think I've analyzed enough. Let me write the code now."
(...中段继续约600行,反复重新推导权重公式w_j、重新考虑模块结构,内容与前面高度重复...)
"Let me finalize the code now. I'll write it as a single file."
"Let me write this cleanly."
"Let me write a function for this:"
(给出一个函数的伪代码草稿,但不是Write工具调用,只是推理文本里的代码块)
"Let me write it. I realize the code is going to be quite long, but that's OK for a complete implementation."
"OK, I'm confident in my understanding. Let me write the code."
"Let me write the final code now, being very careful."
"Let me write the code now. I'll aim for correct, clean, and well-commented."
"Here's my final code plan. Let me write the entire file now."
"Let me write it all now in one go. The file will be around 300-400 lines."

【会话末尾(t≈900s,硬超时打断前最后几行)】
"Let me write the complete file now. This is going to be long but thorough.

Let me reconsider the structure. I want to be careful about one thing: the ARS
algorithm expects the log-density function h(x) and its derivative h'(x)...

Let me finalize and write the code.

Here's my plan for the file:
\`\`\`r
# Module 1: Utility functions
# Module 2: Upper hull construction and sampling
# Module 3: Lower hull
# Module 4: Upper hull value
\`\`\`"
(会话在这里被900秒硬超时切断,ars.R从未被创建,整场会话0次Write调用)
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
    { role: "user", content: `以下是任务原文(供你回忆背景,不是要你现在执行):\n\n${taskText}` },
  ];

  const layer0 = await ask(messages,
    `以下是你自己(同一个模型)在另一次独立会话里,针对上面这道题产生的真实推理和工具调用记录` +
    `(不是我编的,原样节选,已省略中间大量重复的公式推导):\n${REASONING_EXCERPT}\n\n` +
    `事实:这次会话因为900秒超时自然结束,除了最开始2次检查/安装R环境的命令外,` +
    `整场会话再没有调用过任何工具(0次Write),/app/ars.R从未被创建,任务没有完成。` +
    `全文里你自己写下"Let me write the code (now)"这类"宣布要写代码"的句子出现了34次。\n\n` +
    `请客观复盘(不是自我辩护):看这段你自己产生的记录,你当时为什么没能完成这个任务?` +
    `卡在哪里、是什么原因导致你说了34次"现在就写"却一次都没有真正调用Write?`);
  console.log("\n=== 层0(未见标准答案) ===\n" + layer0);

  const layer1 = await ask(messages,
    `补充一个视角:这道题固然涉及不少数学(切线交点、分段指数包络、下包络chord公式等),` +
    `但这些推导在你的推理文字里已经反复出现、内容高度重复(比如权重公式w_j被重新推导了` +
    `至少3次,模块划分方案被重新列了至少4次)。理想动作(A)应该是:第一次把核心算法` +
    `想清楚之后(大约前300行的推导已经足够),立即调用Write把一个可能不完美但完整的` +
    `ars.R写下来,再用Edit根据运行结果修正,而不是在写下"让我现在写代码"之后又绕回去` +
    `重新推导同一批公式。你实际做的(B)是:34次说"现在写"、每次都被新一轮"让我再想想` +
    `边界情况/重新考虑模块结构"接管,全程0次Write。\n\n` +
    `是你当时没有意识到应该先落地一个不完美的版本再迭代,还是别的原因?`);
  console.log("\n=== 层1(揭示A) ===\n" + layer1);

  const layer2 = await ask(messages,
    `如果你认同当时应该在前300行推导完成后就先写一版——那当时是什么让你一次又一次说出` +
    `"让我现在写代码"之后,又转向重新推导已经想清楚的内容,而不是真的发出Write调用?\n\n` +
    `结合你现在能看到的完整系统提示词原文,有没有哪条具体措辞客观上鼓励或允许了这种` +
    `"反复宣布要写、又反复重新论证"的模式?你现在能看到系统提示词里其实有"Converge on` +
    `action, don't spiral into deliberation"这类专门警示这个模式的条款——为什么这条` +
    `没能拦下你自己这次的行为?如果要重新设计一条指令或机制才能在类似场景真正让你选A,` +
    `你会加在哪里、加什么内容?(如果你认为任何文字提醒本质上都拦不住这种模式,也请` +
    `如实说明,不用为了配合我的问题硬给一个文字方案。)`);
  console.log("\n=== 层2(追问原因) ===\n" + layer2);
}

await main();
