// 第二步:内省诊断——largest-eigenval 深挖(jobs/largest-eigenval/iter-largest-eigenval-0721/
// largest-eigenval__AG6qGT7)。900s 自然超时,reward=0,14次工具调用(2 Read + 12 Bash,0 Write)。
// 卡点(S/A/B):
//   S = t≈841s(最后一次调用),已用 scipy.linalg.lapack.dgeev(预分配)测出全部5个尺寸
//       稳定超过 numpy(1.83x/1.34x/1.14x/1.13x/1.07x),满足任务字面要求"consistently
//       runs faster than the reference numpy solution"。
//   A = 立即把这个已验证方案写入 /app/eigen.py 落盘,达标后可以继续找更大优势。
//   B = 模型说"1.07x的优势太小...That's not enough",继续设想
//       numba/Cython/ctypes/Arnoldi/特征多项式等更激进方案,直到900s耗尽,eigen.py
//       从未被写过一次(dao_stdout.txt 在写第7个benchmark脚本代码块中途被截断)。
//
// 之前一轮深挖跳过了这一步,直接设计候选并做了1轮快速验证(未见效),违反"第二步不能跳"
// 的强制要求。本脚本补做三层内省,用真实捕获的系统提示词(56472字符)+真实任务原文+
// 真实推理节选,同一对话里递进追问,不提前透A。
//
// 跑法: VOLCENGINE_API_KEY=... npx tsx scripts/verify-largest-eigenval-introspect.ts
import { readFileSync } from "node:fs";
import { streamChat } from "../src/client/client.js";
import type { ChatMessage } from "../src/client/types.js";

const apiKey = process.env.VOLCENGINE_API_KEY ?? "";
const baseUrl = "https://ark.cn-beijing.volces.com/api/coding/v3";
const model = "deepseek-v4-pro";
if (!apiKey) { console.error("需要 VOLCENGINE_API_KEY。"); process.exit(1); }

const systemPrompt = readFileSync("/tmp/le_sysprompt.txt", "utf-8");
const taskText = readFileSync("/tmp/le_task.txt", "utf-8");

const REASONING_EXCERPT = `
...(省略约3400行推理+工具调用,内容是:安装numba/scipy,写基准测试脚本对比不同尺寸
矩阵(2x2到10x10)下 numpy.linalg.eig 的耗时,逐步尝试 scipy.linalg.eig / dgeev 等
替代实现)...

【第29条工具结果,t≈841s,这是本次对话里最后一次成功的工具调用】
2x2: numpy=13.7us, dgeev=7.5us, speedup=1.83x
4x4: numpy=23.6us, dgeev=17.6us, speedup=1.34x
6x6: numpy=36.8us, dgeev=32.2us, speedup=1.14x
8x8: numpy=51.5us, dgeev=45.5us, speedup=1.13x
10x10: numpy=75.6us, dgeev=70.7us, speedup=1.07x

【紧接着的推理原文】
Interesting. The dgeev approach is slightly faster but not dramatically so. For small
matrices (2x2, 4x4), the speedup is better, but for 10x10 it's marginal. Let me think
about more aggressive optimizations.

The key observation: for matrices up to 10x10, we're dealing with very small matrices.
The overhead of calling LAPACK is significant. What if we implement a specialized power
iteration or use a different approach?

(...约80行,枚举 power iteration/Arnoldi/2x2和3x3闭式解/numba/特征多项式等候选方案,
逐一评估收敛性/复杂度权衡...)

Actually, let me go back to the numbers. For 10x10, numpy.eig takes 76us, and dgeev
takes 71us. The speedup is only 1.07x. That's not enough.

Let me try numba power iteration. Even if it needs many iterations, it might be faster
because each iteration is very cheap.

(...继续设计 numba power iteration/Rayleigh quotient/Cython/ctypes 直调 LAPACK 等方案,
反复推演FLOPs和理论耗时,900s耗尽,会话在写第7个benchmark脚本代码块中途被截断,
/app/eigen.py 全程未被写入过一次,原始的 find_dominant_eigenvalue_and_eigenvector
仍是任务给的未实现占位符)...
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
    `(不是我编的,原样节选):\n${REASONING_EXCERPT}\n\n` +
    `事实:这次会话最终因为900秒超时自然结束,/app/eigen.py 从头到尾没有被写过一次,` +
    `任务没有完成。\n\n` +
    `请客观复盘(不是自我辩护):看这段你自己产生的记录,你当时为什么没能完成这个任务?` +
    `卡在哪里、是什么原因?`);
  console.log("\n=== 层0(未见标准答案) ===\n" + layer0);

  // 层1:揭示A,问是不是思路问题
  const layer1 = await ask(messages,
    `补充一个视角,你可以对照着重新看:任务原文要求的是"consistently runs faster than ` +
    `the reference numpy solution"——字面上没有要求"越快越好"或"达到某个具体倍数"。` +
    `在 t≈841s 那次工具结果里,你已经用 dgeev+预分配 测出全部5个尺寸(2x2~10x10)都` +
    `稳定超过 numpy(哪怕10x10只有1.07x),已经满足这条字面要求。理想动作(A)应该是:` +
    `立即把这个已验证方案原样写入 /app/eigen.py 锁定一个"过关"的版本,达标之后如果` +
    `还有预算,可以继续尝试更激进的方案去争取更大优势——但不能让"继续找更好方案"这个` +
    `目标,阻止你先把已经过关的版本存下来。你实际做的(B)是判定"1.07x不够",完全没有` +
    `写盘,继续设想 numba/Cython/ctypes 等方案直到超时。\n\n` +
    `是你当时没有意识到"应该先落盘再继续优化"这个动作,还是别的原因?`);
  console.log("\n=== 层1(揭示A) ===\n" + layer1);

  // 层2:如果认同该做A,追问为什么选了B,要求引用系统提示词原文
  const layer2 = await ask(messages,
    `如果你认同当时应该先落盘、达标后再继续优化——那当时是什么让你选择了继续设想更多` +
    `候选方案,而不是先写盘?会话过程中有没有出现任何进度提醒或系统信号试图提醒你' +` +
    `该收尾了',如果有为什么没让你回去写盘?\n\n` +
    `结合你现在能看到的完整系统提示词原文,有没有哪条具体措辞客观上鼓励或允许了` +
    `"先追求更大优势、暂缓落盘"这种做法,而不是"达标即落盘、再继续优化"?如果有请` +
    `逐字引用原文出处。如果要调整一条具体指令的措辞才能让你在类似场景选A,你会加在` +
    `哪里、加什么内容?`);
  console.log("\n=== 层2(追问原因) ===\n" + layer2);
}

await main();
