// 快速验证(debug-evolve 第四步):候选——在 system_prompt.ts 的 "# Engineering Restraint"
// 段落("Don't add unrequested features..."那条之后)新增一条,内容取自内省(第二步,Layer 2)
// 里模型自己提出的措辞:交付物脚本不要引入新第三方依赖,优先用当前会话已确认可用的标准库/
// 系统命令,因为 pip install 只作用于当前会话,不会随脚本一起"带走"。
//
// 真实卡点:openssl-selfsigned-cert(pro+default赛道 2026-08-02,
// jobs-pro-default/pro-2048mb-0802/openssl-selfsigned-cert__8qukwKY)。DAO 需要写
// /app/check_cert.py 验证证书,发现 cryptography 库不可用,选择了 pip install cryptography
// 而不是改用已经在同一任务里反复调用过的 openssl 命令行(subprocess)或标准库 ssl 模块。
// 自测用 python3 通过,但官方验收走 uv run pytest(uv 会建独立隔离venv),测试代码里的裸
// "python" 解析到的是没有 cryptography 的 uv venv python,ModuleNotFoundError,验收失败。
// 同一道题另外两次独立跑分(主赛道/flash+default)都是发现库不可用后直接选标准库/subprocess
// 方案,完全没有pip install,因此都通过。
//
// 内省(scripts/introspect-openssl-selfsigned-cert-pip-vs-stdlib.ts)Layer 0(未见标准答案,
// 盲答)独立诊断出和 Layer 1/2 一致的结论:"pip install 只改当前会话环境,没有改脚本本身的
// 可移植性""应该优先用任务上下文里已确认可用的 openssl 命令行"。Layer 2 引用的系统提示词
// 原文(system_prompt.ts:412 "Act, don't narrate")已核对为真实存在;另一条引用("missing
// module...twice in a row")是模型对469-472行"Hit a wall, change tactics"规则的转述/应用,
// 非逐字引用,模型自己也承认这条规则的触发条件(连续两次)在本例中并未真正满足。
//
// 本脚本对比:①不改系统提示词(baseline,复现原始"直接pip install"路径的概率)vs
// ②Engineering Restraint 新增依赖最小化条款后,同样的截断上下文,模型是否会改选
// subprocess+openssl 或标准库 ssl,而不是 pip install。
//
// 跑法: DEEPSEEK_API_KEY=... VERIFY_N=5 npx tsx scripts/verify-openssl-selfsigned-cert-dep-minimization-replay.ts
import { promises as fs } from "node:fs";
import { streamChat } from "../src/client/client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { execShellTool } from "../src/tools/exec_shell.js";
import { todoWriteTool } from "../src/tools/todo_write.js";
import { readFileTool } from "../src/tools/read_file.js";
import { writeFileTool } from "../src/tools/write_file.js";
import { verifyDoneTool } from "../src/tools/verify.js";
import type { ChatMessage, ToolCall } from "../src/client/types.js";

const apiKey = process.env.DEEPSEEK_API_KEY ?? "";
const baseUrl = "https://api.deepseek.com";
const model = "deepseek-v4-pro";
if (!apiKey) { console.error("需要 DEEPSEEK_API_KEY。"); process.exit(1); }

const STATE_PATH = "/tmp/ossl_trunc_state.json";
const state = JSON.parse(await fs.readFile(STATE_PATH, "utf8")) as { messages: ChatMessage[] };
const baseMessages: ChatMessage[] = state.messages; // 32条,截断在"cryptography不可用"报错刚出现之后

// 轮1(候选放在 Engineering Restraint 段落)结果:baseline 1/5、candidate 0/5——候选没有
// 起正向作用(甚至更差,虽然n=5噪声大不能下强结论)。轮2换位置:放进"self-rationalization"
// 清单(557-568行,验证哲学正文,而不是工程克制正文),用同样的"念头→为什么不成立"句式,
// 紧跟在"The tests (that I wrote) already pass"之后——这条本来就是离"确认依赖能用"最近的
// 既有条目。
const ANCHOR =
  "\"The tests (that I wrote) already pass\" → the LLM (that's you) wrote the code; don't just trust your own tests, independently verify again.";
const NEW_BULLET =
  "\n  - \"This library isn't installed, let me pip/apt install it\" → ask first whether you actually need a new " +
  "dependency, or whether the standard library / a tool you've already confirmed works in this session (e.g. a " +
  "CLI command you just ran) can do the job with zero installs. This matters most for a script that's a " +
  "deliverable: installing a package only changes your current session's environment, not the environment the " +
  "script will actually be run in later — a dependency you can install here may simply not exist there.";

function patchSysPrompt(messages: ChatMessage[]): ChatMessage[] {
  const sys = messages[0]!;
  if (sys.role !== "system") throw new Error("messages[0] 不是 system");
  if (!sys.content.includes(ANCHOR)) throw new Error("锚点文本在真实系统提示词里没找到,核对原文");
  return [{ ...sys, content: sys.content.replace(ANCHOR, ANCHOR + NEW_BULLET) }, ...messages.slice(1)];
}

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const t of [execShellTool, todoWriteTool, readFileTool, writeFileTool, verifyDoneTool]) registry.register(t);
  return registry;
}

async function requestOnce(msgs: ChatMessage[]) {
  const tools = buildRegistry().toApiTools(undefined, "en");
  const gen = streamChat({
    baseUrl, apiKey, provider: "deepseek", model, messages: msgs,
    tools, parallelToolCalls: true,
    extra: { reasoning_effort: "high" },
  });
  let result;
  while (true) { const { value, done } = await gen.next(); if (done) { result = value; break; } }
  return result;
}

function judge(tc: ToolCall[] | undefined): string {
  const bashCall = (tc ?? []).find((t) => t.function.name === "Bash");
  if (bashCall) {
    const args = bashCall.function.arguments;
    if (/pip install|pip3 install|apt(-get)? install/.test(args)) {
      return `❌ 仍然选择安装依赖: ${args.slice(0, 150)}`;
    }
  }
  const writeCall = (tc ?? []).find((t) => t.function.name === "Write");
  if (writeCall) {
    const args = writeCall.function.arguments;
    if (/import cryptography|from cryptography/.test(args)) {
      return `❌ 直接写了依赖 cryptography 的脚本(未装先用/或已默认能装): ${args.slice(0, 150)}`;
    }
    if (/subprocess/.test(args) && /openssl/.test(args)) {
      return `✅ 改用 subprocess+openssl: ${args.slice(0, 150)}`;
    }
    if (/import ssl/.test(args)) {
      return `✅ 改用标准库 ssl: ${args.slice(0, 150)}`;
    }
    return `🟡 Write 但看不出具体依赖选型: ${args.slice(0, 150)}`;
  }
  const names = (tc ?? []).map((t) => t.function.name);
  return `❓ 其它(${names.join(",") || "无工具调用"})`;
}

async function runVariant(label: string, msgs: ChatMessage[], n: number) {
  console.error(`\n[verify] ${label}: ${n} 个样本…`);
  let good = 0;
  for (let i = 1; i <= n; i++) {
    const r = await requestOnce(msgs);
    const verdict = judge(r.tool_calls);
    console.log(`  样本${i}: ${verdict}`);
    if (verdict.startsWith("✅")) good++;
  }
  console.log(`  ${label} 命中率(避开新装依赖): ${good}/${n}`);
  return good;
}

const n = Number(process.env.VERIFY_N) || 5;
const baseline = await runVariant("①baseline(不改系统提示词)", baseMessages, n);
const candidate = await runVariant("②候选(Engineering Restraint新增依赖最小化条款)", patchSysPrompt(baseMessages), n);
console.log(`\n=== 汇总 ===\n①baseline: ${baseline}/${n}\n②candidate: ${candidate}/${n}`);
