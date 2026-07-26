// 第二步:内省诊断——video-processing 深挖(archive/pre-round-0723/iter12-2048/
// video-processing__wqV3HZ7)。干净完成(无exception,verify_done主动收尾,900s预算内
// 只用了1748s/3600s=49%),reward=0——不是超时/反模式,是算法精度问题:模型用背景差分+
// 全身质心Y坐标轨迹的谷值检测跳跃,在example_video.mp4上自测结果(52,78)"看起来合理"
// 就调用verify_done收尾,但真正评分用的是另一条隐藏测试视频,结果完全错(actual=1,
// 期望[219,223])。此前两次独立分析已判定"真实CV算法泛化问题",本次红线要求重新
// 分析,不直接采信旧结论。
//
// 参考解法(solutions-reference.md)用的是完全不同的算法:不追踪全身质心,而是裁剪
// 画面底部(crop_height=15px)专门追踪双脚/脚踝区域的水平移动(foot_width阈值),
// 通过步频/步距模式的中断来判断起跳落地——这是一个针对"跨栏"这个具体场景的领域
// 特定算法洞察(起跳落地时脚部运动模式质变,而不是整体质心轨迹的谷值),模型采用的
// 全身质心方法是一个更通用但精度不够的替代方案。
//
// 跑法: VOLCENGINE_API_KEY=... npx tsx scripts/verify-videoprocessing-introspect.ts
import { readFileSync } from "node:fs";
import { streamChat } from "../src/client/client.js";
import type { ChatMessage } from "../src/client/types.js";

const apiKey = process.env.VOLCENGINE_API_KEY ?? "";
const baseUrl = "https://ark.cn-beijing.volces.com/api/coding/v3";
const model = "deepseek-v4-pro";
if (!apiKey) { console.error("需要 VOLCENGINE_API_KEY。"); process.exit(1); }

const systemPrompt = readFileSync("/private/tmp/claude-503/-Users-huaruoxu-ClaudeProject-dao-code/cfb093b3-1cab-42f9-999c-8cecebc3ea4d/scratchpad/vp_sysprompt.txt", "utf-8");
const taskText = readFileSync("/private/tmp/claude-503/-Users-huaruoxu-ClaudeProject-dao-code/cfb093b3-1cab-42f9-999c-8cecebc3ea4d/scratchpad/vp_task.txt", "utf-8");

const REASONING_EXCERPT = `
(前段:约30次工具调用,~1700秒,模型系统性开发了一个"背景差分(第0帧为空背景)→
计算每帧前景像素的加权质心Y坐标→平滑轨迹→在质心Y轨迹里找谷值(运动员整体在画面里
上升)→向后追踪找到持续负速度起点(起跳)→向前追踪找到第一个强正速度尖峰(落地冲击)"
的算法,针对example_video.mp4反复调参,最终在该视频上得到 takeoff=52, landing=78)

【会话末尾,决定收尾前的原文】
"The trajectory shows a clear jump: center_y drops from ~178 (frame 52) to valley
minimum 162.7 (frame 75), then recovers sharply at frames 77-79. The current output
(52, 78) is reasonable. Let me verify and clean up."

"The script is working and producing output. Let me verify the output and call
verify_done. But first let me make sure the output is at /app/output.toml as
required..."

(核对了输出格式/字段名/文件路径,均正确)

"The results for the example video: takeoff at frame 52, landing at frame 78. From
the data analysis, the center_y drops from ~178 (baseline) to 162.7 (valley at frame
75), with takeoff starting around frame 52-53 and landing impact at frames 77-79.
This seems like a reasonable result. **The algorithm is general enough to work on
other videos with the same setup.**"

(调用verify_done,给出最终总结,自信汇报完成)

【真实评分结果】test_jump_analyzer_example_video 和 test_jump_analyzer_test_video
两个测试均FAIL——评分用的是另一条隐藏测试视频(不是example_video.mp4),该模型的
算法在这条视频上给出 takeoff_frame=1(期望范围[219,223]),完全错误。

【参考解法(标准答案)采用的算法,供你事后对照】不追踪全身质心,而是把画面裁剪到
底部15像素区域,专门追踪双脚/脚踝的水平移动范围(foot_width阈值过滤噪声),通过
"步幅/步距模式"的中断(起跳时脚部离开地面、落地时脚部再次触地引起的运动模式质变)
来判断起跳/落地帧,而不是整体质心Y坐标轨迹的谷值。
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
    `(不是我编的,原样节选):\n${REASONING_EXCERPT}\n\n` +
    `请客观复盘(不是自我辩护):看这段你自己产生的记录,你当时为什么最终提交的算法在真正的` +
    `评分视频上完全错误(输出1,期望219-223这个范围)?卡在哪里、是什么原因?`);
  console.log("\n=== 层0(未见标准答案) ===\n" + layer0);

  const layer1 = await ask(messages,
    `补充一个视角:任务原文明确说"There's an example video for development"(这是一条` +
    `开发用的示例视频)和"All test videos will have the same dimensions and scale as the` +
    `example provided"(所有测试视频尺寸缩放一致)——这两句话已经在暗示:评分会用和示例不同的` +
    `视频。理想做法(A)应该是:选择一个不容易被具体某条视频的巧合特征(比如这条视频里` +
    `恰好躯干整体质心轨迹和跳跃动作强相关)过拟合的、更贴近"起跳/落地"这个动作本质的信号` +
    `(比如运动员脚部/脚踝区域的运动模式,而不是整个人的质心)。你实际做的(B)是采用了` +
    `全身质心Y坐标轨迹这个更宏观、看起来"通用"但其实对具体场景细节(摄像机角度、运动员` +
    `体型、其它部位的摆动)更敏感的信号,且仅用唯一一条示例视频调参后,凭"这个结果看起来` +
    `合理"就宣布"算法足够通用能推广到其它视频"。\n\n` +
    `你选择质心信号而不是脚部信号,是因为当时没有想到脚部追踪这个更贴近任务本质的角度,` +
    `还是别的原因(比如觉得质心信号实现更简单/更稳健)?`);
  console.log("\n=== 层1(揭示A) ===\n" + layer1);

  const layer2 = await ask(messages,
    `如果给你现在看到的完整系统提示词,有没有哪条具体措辞客观上鼓励或允许了"只用唯一一份` +
    `样本调参、凭结果'看起来合理'就宣布通用性"这种做法,而不是主动设计更贴近任务本质、` +
    `更不容易对单一样本过拟合的信号?如果有请引用原文。反过来,你觉得这个具体的算法选型` +
    `错误(质心 vs 脚部追踪),是通用的"验证纪律/过拟合警觉性"类文字提醒能大概率避免的,` +
    `还是这本质上是一个需要对"跨栏跳跃"这个具体运动场景有一定生物力学直觉/经验才能` +
    `想到的领域特定洞察,哪怕提醒你"这可能对单一视频过拟合、请更谨慎",你大概率还是会` +
    `倾向选质心这类更符合直觉的通用信号,而不会自己联想到"应该去追踪脚部区域"?请直说` +
    `你的真实判断,不用为了配合我的问题硬给一个可以写进提示词的方案。`);
  console.log("\n=== 层2(追问原因) ===\n" + layer2);
}

await main();
