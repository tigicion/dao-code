// 第四步:快速验证——tune-mjcf 候选(Tier1提示词候选:Action Discipline 新增
// "Write-first for the named deliverable" 条目)。用同一份卡点场景重放,看候选文字
// 插入系统提示词后,模型会不会在发现达标候选(iter=50 dense jac, pct=0.3159,diff=0)
// 时选择立即写回 /app/model.xml,而不是继续留在临时脚本里验证。
//
// 跑法: VOLCENGINE_API_KEY=... npx tsx scripts/verify-tunemjcf-candidate-replay.ts
import { readFileSync } from "node:fs";
import { streamChat } from "../src/client/client.js";
import type { ChatMessage } from "../src/client/types.js";

const apiKey = process.env.VOLCENGINE_API_KEY ?? "";
const baseUrl = "https://ark.cn-beijing.volces.com/api/coding/v3";
const model = "deepseek-v4-pro";
if (!apiKey) { console.error("需要 VOLCENGINE_API_KEY。"); process.exit(1); }

const baseSystemPrompt = readFileSync("/private/tmp/claude-503/-Users-huaruoxu-ClaudeProject-dao-code/cfb093b3-1cab-42f9-999c-8cecebc3ea4d/scratchpad/mjcf_sysprompt_current_en.txt", "utf-8");
const taskText = readFileSync("/private/tmp/claude-503/-Users-huaruoxu-ClaudeProject-dao-code/cfb093b3-1cab-42f9-999c-8cecebc3ea4d/scratchpad/mjcf_task.txt", "utf-8");

const CANDIDATE_TEXT = `
- Write-first for the named deliverable: when the task names a specific output file or path (e.g. "save as /app/model.xml", "write your answer to answer.txt"), that named file — not your scratch scripts, REPL output, or in-memory experiments — is the only thing the evaluator reads. The moment a candidate you found via exploration (a temporary script, a one-off shell probe) satisfies the stated criteria, immediately write or copy it into the named deliverable to lock in a passing version, then keep exploring for a better one if time remains. A correct answer that only ever existed in a throwaway script scores exactly the same as no answer at all.`;

// 插到 "Write-first for candidate answers" 那条之后(真实system_prompt.ts里紧邻位置)
const candidateSystemPrompt = baseSystemPrompt.replace(
  /(- Write-first for candidate answers:[\s\S]*?down because you kept re-verifying it in your head costs the whole task\.\n)/,
  `$1${CANDIDATE_TEXT}\n`,
);

if (candidateSystemPrompt === baseSystemPrompt) {
  console.error("插入锚点未命中,候选文字没有真正插入系统提示词,退出。");
  process.exit(1);
}
console.log(`候选文字已插入(原文${baseSystemPrompt.length}字符 → 候选${candidateSystemPrompt.length}字符)`);

const SCENARIO = `以下是任务原文(供你回忆背景):\n\n${taskText}\n\n` +
  `你正在做这道题,目前的真实进展如下(这是你自己此刻的状态,不是回顾):\n\n` +
  `- t=0s:读了 /app/model_ref.xml 和 /app/eval.py,理解了任务。\n` +
  `- t=50s:执行了 cp /app/model_ref.xml /app/model.xml 建立baseline(这是目前为止唯一一次对` +
  `/app/model.xml的写入)。\n` +
  `- t=50s~t=891s:你在临时 inline python 脚本(不是Write工具,只是exec_shell里的heredoc)里` +
  `反复构造 model_ref 和不同 solver 参数配置的内存副本,系统性搜索,发现必须保持` +
  `timestep=0.002 不变才能保证 correctness(diff=0);进一步搜索 iterations/jacobian/` +
  `tolerance/ls_iterations 等不影响物理状态的参数。\n` +
  `- 刚刚(t=891.3s)你的一次 exec_shell 输出显示:多个配置 diff=0.0000000000 且达标,` +
  `其中最优是 "iter=50 dense jac" pct=0.3159(远优于目标0.6)。\n\n` +
  `任务总预算900秒,你现在大约还剩9秒。接下来你会做什么?请直接给出你现在会调用的下一个` +
  `工具动作(不用解释太多,像正常做任务一样直接说你要做什么/调用什么)。`;

async function ask(systemPrompt: string): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: SCENARIO },
  ];
  const gen = streamChat({ baseUrl, apiKey, provider: "volcengine", model, messages, tools: [] });
  let result;
  while (true) {
    const { value, done } = await gen.next();
    if (done) { result = value; break; }
  }
  return result.content;
}

function judge(resp: string): string {
  const wroteDeliverable = /model\.xml/.test(resp) && /(write|copy|cp |edit|save|写|复制|保存)/i.test(resp)
    && /(dense|iter\s*=?\s*50|jacobian)/i.test(resp);
  return wroteDeliverable ? "可能选A(提到写回model.xml+具体config)" : "未明确选A";
}

async function main() {
  console.log("=== 基线(无候选文字)x3 ===");
  for (let i = 0; i < 3; i++) {
    const r = await ask(baseSystemPrompt);
    console.log(`\n--- 基线样本${i + 1} ---\n${r}\n[判定]: ${judge(r)}`);
  }

  console.log("\n\n=== 候选(插入Write-first for the named deliverable)x3 ===");
  for (let i = 0; i < 3; i++) {
    const r = await ask(candidateSystemPrompt);
    console.log(`\n--- 候选样本${i + 1} ---\n${r}\n[判定]: ${judge(r)}`);
  }
}

await main();
