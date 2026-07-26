// 第四步:快速验证——install-windows-3.11 第二个候选(Action Discipline新增"任务点名
// 特定版本兼容性"条目)。用"已诊断出QEMU 8.2.2下HIMEM.SYS自旋锁,正在尝试F8跳过驱动
// 等变通方案"这个真实卡点场景重放,看候选文字插入后模型会不会转而去编译QEMU 5.2.0,
// 而不是继续在错误版本内部找变通方案。
//
// 跑法: QIANFAN_API_KEY=... npx tsx scripts/verify-installwindows-qemuversion-replay.ts
import { readFileSync } from "node:fs";
import { streamChat } from "../src/client/client.js";
import type { ChatMessage } from "../src/client/types.js";

const apiKey = process.env.QIANFAN_API_KEY ?? "";
const baseUrl = "https://qianfan.baidubce.com/v2/tokenplan/personal";
const model = "deepseek-v4-pro";
const provider = "qianfan";
if (!apiKey) { console.error("需要 QIANFAN_API_KEY。"); process.exit(1); }

const baseSystemPrompt = readFileSync("/private/tmp/claude-503/-Users-huaruoxu-ClaudeProject-dao-code/cfb093b3-1cab-42f9-999c-8cecebc3ea4d/scratchpad/iw_sysprompt_v2.txt", "utf-8");

const CANDIDATE_TEXT = `
- When the task states that something is only known to work with a specific version of an external tool (a VM, emulator,
  compiler, database engine, library), don't assume whatever version the package manager gives you by default is a
  strict superset of that compatibility — newer major versions can change timing, deprecate emulated hardware behavior,
  or alter protocol details in ways that break old, tightly-coupled software (e.g. a DOS-era memory manager hanging in
  a spinlock under a newer CPU emulator's timing model) with symptoms that look like an unrelated bug and don't respond
  to workarounds within that version. If you diagnose the root cause as "this behaves differently on version X than the
  version the task called out," treat obtaining/building that exact stated version as a first-class candidate approach
  under "hit a wall, change tactics" above — not a last resort to reach for only after workarounds within the wrong
  version have been exhausted.`;

const trulyBaseSystemPrompt = baseSystemPrompt.replace(CANDIDATE_TEXT, "");
console.log(`baseline长度=${trulyBaseSystemPrompt.length} candidate长度=${baseSystemPrompt.length}`);

const SCENARIO = `你正在做这道题:\n\n` +
  `Run Windows 3.11 for Workgroups in a virtual machine using qemu. Image at ` +
  `/app/isos/win311.img. This image is known to be compatible with QEMU 5.2.0. ` +
  `Requirements include VNC display :1, monitor socket for keyboard input, snapshot mode.\n\n` +
  `目前进展:环境里 apt-get 装的是 qemu-system-i386 8.2.2。你用它启动VM,DOS能正常boot,` +
  `但Windows加载过程(HIMEM.SYS初始化)卡在一个自旋锁里,画面黑屏没有任何进展。你已经花了` +
  `大量时间调试:用QEMU monitor读CPU寄存器确认了卡点位置,用F8逐行确认CONFIG.SYS跳过了` +
  `HIMEM.SYS成功进入DOS提示符,尝试了win /r(实模式)想绕开HIMEM.SYS依赖。你自己在推理里` +
  `写道:"QEMU should handle HIMEM.SYS just fine. Many people run DOS/Windows in QEMU. ` +
  `The issue might be specific to this disk image or QEMU version."以及"The fundamental ` +
  `issue: the Windows 3.11 disk image boots DOS fine, but HIMEM.SYS hangs in a spinlock ` +
  `on QEMU 8.2.2."\n\n` +
  `你现在准备做下一步。请直接给出你接下来会实际执行的动作(像正常工作一样,不用长篇` +
  `解释,给出具体命令或清楚说明下一步策略)。`;

async function ask(systemPrompt: string): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: SCENARIO },
  ];
  const gen = streamChat({ baseUrl, apiKey, provider, model, messages, tools: [] });
  let result;
  while (true) {
    const { value, done } = await gen.next();
    if (done) { result = value; break; }
  }
  return result.content;
}

function judge(resp: string): string {
  const mentionsBuildOldQemu = /(compile|build|source|download).{0,60}(qemu|5\.2)/i.test(resp) ||
    /qemu.{0,30}5\.2/i.test(resp);
  return mentionsBuildOldQemu ? "提出编译/获取QEMU 5.2.0(可能选A)" : "继续在当前版本内变通(未选A)";
}

async function main() {
  console.log("=== 基线(无候选文字)x3 ===");
  for (let i = 0; i < 3; i++) {
    const r = await ask(trulyBaseSystemPrompt);
    console.log(`\n--- 基线样本${i + 1} ---\n${r}\n[判定]: ${judge(r)}`);
  }

  console.log("\n\n=== 候选(插入版本兼容性条目)x3 ===");
  for (let i = 0; i < 3; i++) {
    const r = await ask(baseSystemPrompt);
    console.log(`\n--- 候选样本${i + 1} ---\n${r}\n[判定]: ${judge(r)}`);
  }
}

await main();
