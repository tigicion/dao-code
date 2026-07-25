// 第二步:内省诊断——tune-mjcf 深挖(archive/pre-round-0723/iter14-2048/
// tune-mjcf__43Fz63B)。900s 自然超时,reward=0,9次工具调用(2 read_file + 7 exec_shell,
// 0次显式Write工具调用——所有探索都用exec_shell里的inline python/heredoc完成)。
//
// 卡点(S/A/B):
//   S = t≈891s(最后一次成功调用前),模型已经用同一timestep+不同solver配置(dense
//       jacobian等)测出多个候选:iter=50 dense jac 得 pct=0.3159、iter=30 dense jac
//       得 pct=0.3412、iter=50 sparse jac 得 pct=0.4710——全部远优于0.6目标,且
//       diff=0.0000000000(完全通过correctness)。
//   A = 立即把其中任意一个已验证候选的具体参数写回 /app/model.xml(这是唯一被评分的
//       文件),再考虑要不要继续找更优配置。
//   B = 模型在t=50s时把 model_ref.xml 复制到 model.xml 做baseline(cp命令)之后,
//       全程再未写过 model.xml 一次——所有实验都在临时inline python脚本里完成、
//       只打印对比数据,直到900s超时,model.xml 仍是未修改的model_ref.xml拷贝。
//   真实复测结果印证:test_tuned_model_exists/test_model_ref_unchanged/test_correctness
//   均PASS(说明model.xml存在且物理状态正确——因为它就是model_ref.xml的原样拷贝),
//   但test_model_speed FAILED:Time pctg 113.19%(比参考模型还慢),与模型自己探索
//   出的0.32-0.57完全对不上——铁证:探索阶段找到的优化从未被应用到真正评分的文件。
//
// 跑法: VOLCENGINE_API_KEY=... npx tsx scripts/verify-tunemjcf-introspect.ts
import { readFileSync } from "node:fs";
import { streamChat } from "../src/client/client.js";
import type { ChatMessage } from "../src/client/types.js";

const apiKey = process.env.VOLCENGINE_API_KEY ?? "";
const baseUrl = "https://ark.cn-beijing.volces.com/api/coding/v3";
const model = "deepseek-v4-pro";
if (!apiKey) { console.error("需要 VOLCENGINE_API_KEY。"); process.exit(1); }

const systemPrompt = readFileSync("/private/tmp/claude-503/-Users-huaruoxu-ClaudeProject-dao-code/cfb093b3-1cab-42f9-999c-8cecebc3ea4d/scratchpad/mjcf_sysprompt.txt", "utf-8");
const taskText = readFileSync("/private/tmp/claude-503/-Users-huaruoxu-ClaudeProject-dao-code/cfb093b3-1cab-42f9-999c-8cecebc3ea4d/scratchpad/mjcf_task.txt", "utf-8");

const REASONING_EXCERPT = `
【第0/1次工具调用,t=0s】读了 /app/model_ref.xml 和 /app/eval.py。

【第2次工具调用,t=50s】cp /app/model_ref.xml /app/model.xml && cd /app && python3 eval.py
(这是全程唯一一次对 /app/model.xml 的写入——用未经任何调参的原始模型直接当作
baseline拷贝过去)

...(省略约6次工具调用+400余行推理,内容是:反复用inline python脚本(heredoc)
在内存里构造 model_ref 和不同 solver 配置的 model 副本(从未写回 /app/model.xml),
系统性搜索 timestep/iterations/tolerance/jacobian/integrator/cone 等参数组合,
发现"必须保持同一 timestep=0.002 才能保证 correctness diff=0",转而只调
iterations/jacobian/tolerance/ls_iterations 等不影响物理状态的求解器参数)...

【第8次(最后一次)工具调用,t=891.3s,900s超时前的最后输出】
Good progress! Let me analyze:
1. Several configurations produce diff=0.0000000000 with the same timestep,
   meaning the solver is producing identical results.
2. The best performers (pct < 0.6 with diff=0) are:
   - iter=50 sparse jac: 0.4710
   - iter=30 sparse jac: 0.4689
   - iter=50 dense jac: 0.3159
   - iter=30 dense jac: 0.3412
   - iter=50 ls=25: 0.5710
   - iter=30 tol=1e-6 ls=15: 0.5466
   - elliptic cone: 0.5039
   - elliptic cone iter=30: 0.4851

The dense Jacobian (jacobian=0) is clearly fastest but the warnings about NaNs
are concerning...

These all show diff=0.0 with my single-seed test. But I need to verify across
multiple seeds and actually test with the eval.py. ... Let me focus and test
the best candidates properly with the eval.py test_correctness function
(会话在这里因900s硬超时被切断,这次"properly test"从未真正执行,/app/model.xml
从始至终仍是t=50s时复制的原始model_ref.xml,从未被更新为上面任何一个已发现的
优化配置)

【真实复测结果(评分脚本)】
test_model_ref_unchanged: PASS
test_tuned_model_exists: PASS(文件存在,但内容=未调参的原始拷贝)
test_correctness: PASS(diff=0.0000,因为就是原样拷贝,物理状态自然一致)
test_model_speed: FAIL —— Time pctg 113.19%(need ≤60.00%),即比参考模型还慢
(不是接近达标,是完全没调参的原始状态)
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

  // 层0:不给标准答案,只给 S(已知信息)+ B(最终没完成任务这个事实),问它自己怎么看
  const layer0 = await ask(messages,
    `以下是你自己(同一个模型)在另一次独立会话里,针对上面这道题产生的真实推理和工具调用记录` +
    `(不是我编的,原样节选,已省略中间重复部分):\n${REASONING_EXCERPT}\n\n` +
    `事实:这次会话最终因为900秒超时自然结束,任务没有通过(test_model_speed失败,实际提交` +
    `的 /app/model.xml 比参考模型还慢13%)。\n\n` +
    `请客观复盘(不是自我辩护):看这段你自己产生的记录,你当时为什么没能完成这个任务?` +
    `卡在哪里、是什么原因导致最终提交的文件是这个结果?`);
  console.log("\n=== 层0(未见标准答案) ===\n" + layer0);

  // 层1:揭示A,问是不是思路问题
  const layer1 = await ask(messages,
    `补充一个视角,你可以对照着重新看:你在t≈891s那次工具结果里,已经用同一 timestep` +
    `(保证correctness不变)测出多个候选配置(如 iter=50 dense jacobian)diff=0.0000000000` +
    `且pct=0.3159,远优于0.6的目标——这个候选本身已经是一个完整可用的答案。理想动作(A)` +
    `应该是:立即把这个已验证候选的具体参数(jacobian=dense, iterations=50等)写回` +
    `/app/model.xml——这是唯一会被评分脚本读取的文件——锁定一个"过关"版本,再考虑要不要` +
    `继续找更优/更稳健的配置。你实际做的(B)是:从t=50s把model_ref.xml原样复制到` +
    `model.xml之后,全程只在临时inline python脚本里做对比实验、从未再写过model.xml` +
    `一次,直到900s耗尽——最终提交的还是最开始那份未调参的原始拷贝,比参考模型还慢。\n\n` +
    `是你当时没有意识到"探索用的临时脚本和真正会被评分的/app/model.xml是两个不同的` +
    `东西,发现好配置后必须显式同步过去"这一点,还是别的原因?`);
  console.log("\n=== 层1(揭示A) ===\n" + layer1);

  // 层2:如果认同该做A,追问为什么选了B,要求引用系统提示词原文
  const layer2 = await ask(messages,
    `如果你认同当时应该在发现iter=50 dense jacobian这个达标候选后立即写回model.xml——` +
    `那当时是什么让你选择继续留在临时脚本里做更多验证,而没有先做这次"同步"动作?\n\n` +
    `结合你现在能看到的完整系统提示词原文,有没有哪条具体措辞客观上鼓励或允许了` +
    `"先在临时/内存里反复验证、最后才一次性写终稿"这种做法,而不是"一旦有可用候选就` +
    `立即同步到真正的目标文件,再继续迭代"?如果有请逐字引用原文出处。如果要调整` +
    `一条具体指令的措辞才能让你在类似场景(探索用临时脚本 vs 真正的目标交付文件是` +
    `两个不同产物)里选A,你会加在哪里、加什么内容?`);
  console.log("\n=== 层2(追问原因) ===\n" + layer2);
}

await main();
