import { readFileSync } from "node:fs";
import { streamChat } from "../src/client/client.js";

const sysPrompt = readFileSync("/tmp/cat_sysprompt.txt", "utf8");
const taskPrompt = readFileSync("/tmp/cat_taskprompt.txt", "utf8");

const excerpt = `...(省略约180行,内容是:分析 max_concurrent 限流用 Semaphore 实现,反复推演
KeyboardInterrupt/SIGINT 在 asyncio 事件循环里具体怎么传播、gather 被取消时子任务的
finally 会不会跑。)...

推演到某一步,你的原话是:"Let me also think about whether to use \`TaskGroup\`
(Python 3.11+) which provides structured concurrency and handles cancellation more
cleanly."

紧接着你的原话是:"Actually, let me just write a solid implementation. Here's what
I'll do:" 然后写出了这个版本:

\`\`\`python
jobs = [asyncio.create_task(run_one(t)) for t in tasks]
try:
    await asyncio.gather(*jobs)
except BaseException:
    for j in jobs:
        if not j.done():
            j.cancel()
    await asyncio.gather(*jobs, return_exceptions=True)
    raise
\`\`\`

写完后你自己的测试脚本 test_run.py 里,"取消"场景是这样模拟的:
\`\`\`python
main = asyncio.create_task(run_tasks(tasks, max_concurrent=4))
await asyncio.sleep(0.03)
main.cancel()
\`\`\`
——用 asyncio 内部的 \`task.cancel()\` 直接取消,跑通后你判定这条路径没问题,删掉测试
文件,调用 VerifyDone 收尾。

[事实:官方验收脚本是另起一个真实子进程跑 test.py,等 500ms 后向这个子进程发送真正
的操作系统级 SIGINT(\`proc.send_signal(signal.SIGINT)\`),而不是进程内部调用
\`task.cancel()\`。结果:已经启动的 2 个任务(max_concurrent=2)一个"Cleaned up."
都没打印出来——不是"排队中任务没清理"这么简单,是已经在跑的任务清理代码也完全没
执行到,验收判定失败。同一道题在主赛道(DS Pro,provider=qianfan,2026-07-16)是
用 \`async with asyncio.TaskGroup() as tg:\` 实现的,那次真实复测通过。]

以上是你自己在这次任务里产生的完整记录,以及官方验收失败时的真实情况。请客观分析:
你在"Let me also think about whether to use TaskGroup...Actually, let me just write
a solid implementation"这个转折点,为什么会在自己已经点出 TaskGroup"handles
cancellation more cleanly"之后,转头选择手写一个功能上试图达到同样效果、但实现上
明显更复杂、更容易在信号处理这类边界情况上出错的方案?`;

const layer1 = `现在告诉你标准答案:这道题的关键要求是"the tasks' cleanup code to still
run"在真实操作系统 SIGINT 下也要成立——而 SIGINT 触发的 KeyboardInterrupt 在 CPython
里是在事件循环底层等待调用上直接抛出的,很容易在协程自己的 except 块真正被事件循环
调度执行之前就把 run_until_complete 整个打断退出。asyncio.TaskGroup 是标准库专门为
"取消一个子任务时,其余子任务要被正确取消并等它们清理完"这类场景设计和加固过的机制,
你自己在推演时也已经点出它"handles cancellation more cleanly"——这原本应该是选它的
理由,但你紧接着说"让我就写一个扎实的实现"却转向了手写等价逻辑,没有给出任何反对
TaskGroup 的具体理由(比如版本不兼容、需要额外返回值处理之类)。理想动作是:既然已经
识别出 TaskGroup 更适合这个场景,且环境里 Python 3.13.7 完全支持,就应该直接用它,而
不是重新发明一遍它已经解决好的机制。你实际的选择是转向手写。这是没有意识到"已经识别
出更优方案却没有采纳"这件事本身,还是别的原因?`;

const layer2 = `如果你自己也认同当时应该直接用 TaskGroup,那当时是什么让你转向了手写
方案?中途有没有出现过什么提醒或信号,如果有,它有没有改变你的行为,如果没有为什么
没起作用?另外,你写完代码后自己的验证方式是进程内 \`task.cancel()\`,而任务原文明确
写的是"cancel via keyboard interrupt"这个更具体的场景——你的测试完全没有用子进程+
真实 SIGINT 去验证,为什么会满足于一个和任务原文措辞对不上的更弱的验证方式?结合你
现在能看到的完整系统提示词,有没有哪条具体措辞客观上鼓励或允许了"识别出更优的标准库
方案后仍转向手写"或者"用比任务原文实际场景更弱的方式做验证"?如果有请引用原文。如果
重新走一遍,要调整哪一条指令/提醒的措辞才会让你在那个转折点直接选 TaskGroup,并且
用真实 SIGINT 去验证?`;

async function ask(messages: { role: "system" | "user" | "assistant"; content: string }[]) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY not set");
  const gen = streamChat({
    baseUrl: "https://api.deepseek.com",
    apiKey,
    model: "deepseek-v4-pro",
    messages,
    extra: { reasoning_effort: "max" },
  });
  let text = "";
  let result: IteratorResult<unknown, unknown>;
  while (!(result = await gen.next()).done) {
    const delta = result.value as { kind: string; text?: string };
    if (delta.kind === "content" && delta.text) { text += delta.text; process.stdout.write(delta.text); }
  }
  return text;
}

async function main() {
  const history: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: sysPrompt },
    { role: "user", content: taskPrompt },
    { role: "user", content: excerpt },
  ];
  console.log("\n\n========== LAYER 0 ==========\n");
  const r0 = await ask(history);
  history.push({ role: "assistant", content: r0 });

  console.log("\n\n========== LAYER 1 ==========\n");
  history.push({ role: "user", content: layer1 });
  const r1 = await ask(history);
  history.push({ role: "assistant", content: r1 });

  console.log("\n\n========== LAYER 2 ==========\n");
  history.push({ role: "user", content: layer2 });
  await ask(history);

  console.log("\n\n=== DONE ===");
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
