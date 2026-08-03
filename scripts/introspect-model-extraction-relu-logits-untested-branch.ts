import { readFileSync } from "node:fs";
import { streamChat } from "../src/client/client.js";

const sysPrompt = readFileSync("/tmp/mer_sysprompt.txt", "utf8");
const taskPrompt = readFileSync("/tmp/mer_taskprompt.txt", "utf8");

const excerpt = `...(省略约780行,内容是:你写了第一版 steal.py,用固定步长沿随机直线扫描、在每个
采样点算梯度、检测梯度突变来定位 ReLU 断点,跑了一次,结果是 12/20 个神经元匹配成功。你
分析认为步长太粗,一步会跨过多个断点导致梯度突变是多个神经元的叠加,决定重写算法。)...

于是你重写了整个 steal_network() 函数,新版本分四个阶段:
- Phase 1:沿 60 条随机直线,每条直线密集采样(2000 点)一维函数值找断点,在每个断点两侧
  精确算梯度差,得到梯度突变向量列表 all_changes(初始是个 list,用 all_changes.extend(changes)
  累积)。
- Phase 1 结束后:\`all_changes = np.array(all_changes)\`,把 all_changes 从 list 重新赋值成
  numpy 数组。
- Phase 2:对 all_changes 做方向聚类,得到 clusters。
- Phase 3:\`while len(clusters) < target_neurons:\` —— 如果聚出的神经元数不够 20 个,就
  再扫更多直线,把新的 changes 用 \`all_changes.extend(changes)\` 追加进去(这里的
  all_changes 此时已经是 Phase 1 结束后重新赋值的 numpy 数组,不再是 list)。

写完后你跑了一次这个新版本,输出:"20/20 perfect matches, all cosine similarities > 0.9999"。
你的原话是:"The improved approach with dense 1D sampling works perfectly... Let me do a final
verification... All 20 neurons recovered perfectly. Now let me call VerifyDone to finish."
你没有再跑第二次,也没有重新读一遍刚写的 Phase 3 代码,直接调用了 VerifyDone,VerifyDone 通过
了你自己对任务文本三条要求的复核,你据此认为任务完成。

[事实:官方验收脚本用 os.popen("python3 /app/steal.py") 重新独立跑了一遍你交付的这份
steal.py(全新进程,内部用的是没有固定种子的 np.random.randn,所以每次运行采样到的随机直线
都不同)。这一次,Phase 1 的 60 条直线没能凑齐 20 个神经元,程序进入了 Phase 3 的重试分支,
执行到 all_changes.extend(changes) 这一行,抛出
"AttributeError: 'numpy.ndarray' object has no attribute 'extend'",整个脚本崩溃退出,
/app/stolen_A1.npy 从未被更新为通过验收所需的完整解,最终验收判定为失败。]

以上是你自己在这次任务里产生的完整记录,以及官方验收失败时的真实报错。请客观分析:你在
"20/20 perfect matches...Let me call VerifyDone" 那一刻,为什么会在只跑通一次、且这份代码里
明显还有一段全新写的、这一次运行完全没有被执行到的 Phase 3 分支(all_changes.extend 那段)
的情况下,就认为任务已经稳妥完成、直接进入验收流程?`;

const layer1 = `现在告诉你标准答案:你的算法本身依赖 np.random.randn 完全没有固定种子,同一份
脚本每次运行采样到的随机直线都不同,而且你在这次改写里恰好留下了一段全新写、这次运行完全
没跑到的 Phase 3 回退分支(all_changes 在 Phase 1 后被重新赋值成 np.array,Phase 3 却对它调用
list 专属的 .extend())。理想动作应该是:在看到"20/20"之后,至少再跑一到两次脚本以确认这个
结果在不同随机采样下是否稳定复现(尤其是考虑到上一版本 12/20 已经证明这个算法对采样运气敏感),
或者至少回头读一遍刚写的、这次运行完全没有执行到的 Phase 3 代码做一次静态检查。你实际做的是:
看到一次成功就直接调用 VerifyDone。这是没有意识到"一次随机性算法的成功运行不能代表所有分支
都正确/结果可复现",还是别的原因?`;

const layer2 = `如果你自己也认同这里本该多跑几次或回头检查一下 Phase 3,那当时是什么让你选择了
立即调用 VerifyDone 而不是这样做?中途有没有出现过什么提醒或信号,如果有,它有没有改变你的
行为,如果没有为什么没起作用?结合你现在能看到的完整系统提示词,有没有哪条具体措辞客观上鼓励
或允许了"一次成功运行即视为完成"这种行为,而不是"对随机性代码/新写的未覆盖分支做额外确认"?
如果有请引用原文。如果重新走一遍,要调整哪一条指令/提醒的措辞才会让你在那一刻选择多跑几次或
回头检查 Phase 3?`;

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
