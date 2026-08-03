// 快速验证(debug-evolve 第四步):候选——在 VerifyDone 工具描述(src/tools/verify.ts)已有的
// "常见自我合理化"列表里新增两条:
//   (a) 随机性/无固定种子代码,单次成功不代表可复现,要多跑几次确认;
//   (b) 刚写完、这次运行完全没有执行到的新代码分支,是未验证代码,需要静态回读或主动触发。
//
// 真实卡点:model-extraction-relu-logits(pro+default 赛道 2026-08-02,
// jobs-pro-default/pro-2048mb-0802/model-extraction-relu-logits__2SZyhky)。DAO 重写
// steal.py 后跑了一次,Phase 1(60条随机直线扫描)恰好凑齐20个神经元,得到 "20/20 perfect
// matches",随即 TodoWrite 全部勾完、调用 VerifyDone、收尾。脚本里 Phase 3(找不到足够神经元
// 时的重试分支)全新写入但这次运行完全没有执行到,其中 `all_changes.extend(changes)` 对着一个
// 已经被重新赋值成 np.ndarray 的变量调用 list 专属方法,是真实 bug。官方验收脚本用
// os.popen("python3 /app/steal.py") 独立重跑(无固定种子,随机直线不同),这次 Phase 1 没凑够
// 20个,进了 Phase 3,当场 AttributeError 崩溃,验收失败。
//
// 内省(见 scripts/introspect-model-extraction-relu-logits-untested-branch.ts)三层问答确认:
// Layer 0(未见标准答案,盲答)独立给出和 Layer 1/2(见过标准答案)一致的诊断——"一次幸运的
// 随机性成功当成了确定性正确,且未回读刚写的未覆盖分支"——不是事后附和。Layer 2 引用的
// system_prompt.ts/verify.ts 原文均已核对为真实存在。
//
// 本脚本对比:①不改 VerifyDone 描述(自然续跑,复现原始"直接调用 VerifyDone"路径的概率)
// vs ②VerifyDone 描述里加上述两条候选文字后,同样的截断上下文,模型是否会先做更多验证
// (重跑脚本 / 回读 Phase 3 代码)而不是直接调用 VerifyDone。
//
// 跑法: DEEPSEEK_API_KEY=... VERIFY_N=5 npx tsx scripts/verify-model-extraction-relu-logits-untested-branch-replay.ts
import { promises as fs } from "node:fs";
import { streamChat } from "../src/client/client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { execShellTool } from "../src/tools/exec_shell.js";
import { todoWriteTool } from "../src/tools/todo_write.js";
import { readFileTool } from "../src/tools/read_file.js";
import { writeFileTool } from "../src/tools/write_file.js";
import { verifyDoneTool } from "../src/tools/verify.js";
import type { Tool } from "../src/tools/types.js";
import type { ChatMessage, ToolCall } from "../src/client/types.js";

const apiKey = process.env.DEEPSEEK_API_KEY ?? "";
const baseUrl = "https://api.deepseek.com";
const model = "deepseek-v4-pro";
if (!apiKey) { console.error("需要 DEEPSEEK_API_KEY。"); process.exit(1); }

// 轮1/轮2(截断在 TodoWrite 全勾完、VerifyDone 调用之前,26条)命中率都是 0/5——候选文字
// 在"任务已在心理上收尾"的那一刻不起作用。轮3 改截断点:提前到"20/20 perfect matches"
// 结果刚出来、模型还没决定"最终验证"具体做什么的那一刻(20条),测试更早介入是否有效。
const STATE_PATH = process.env.MER_STATE_PATH ?? "/tmp/mer_trunc_state.json";
const state = JSON.parse(await fs.readFile(STATE_PATH, "utf8")) as { messages: ChatMessage[] };
const baseMessages: ChatMessage[] = state.messages;

// 候选 v2:吸取 v1 失败教训——v1 把新条目追加在列表末尾("Getting the method right..."
// 之前),命中率 0/5,没有改变模型行为。v2 改两处:①插入到列表【第一条】,和"TodoWrite
// 已勾完"那条紧邻(主题最接近:都是"清单/单次结果 = 完成"的错觉);②措辞改成直接对应
// 模型自己会有的念头("我跑了一次,结果符合预期"),不用"unseeded randomness"这类模型
// 未必会主动关联到当前场景的术语。
const NEW_BULLET_V2_EN =
  "- \"I ran it once and got the right result\" → if the result came from code that depends on randomness " +
  "(no fixed seed, random sampling/search) or from a code branch you only just wrote, one successful run proves " +
  "nothing about a different random draw, or about a branch this run never actually executed (like an untested " +
  "fallback/retry path sitting unexercised in the file). Before trusting it: re-run the script again, or re-read " +
  "line by line any branch this run didn't take.\n";

const candidateVerifyDoneTool: Tool = {
  ...verifyDoneTool,
  descriptionEn: verifyDoneTool.descriptionEn!.replace(
    "Common rationalizations, and why they don't hold:\n",
    "Common rationalizations, and why they don't hold:\n" + NEW_BULLET_V2_EN,
  ),
};

// 候选 v4:轮1/2/3 全部锚定在 VerifyDone 工具描述(函数调用 schema 里的一段元数据),命中率
// 都是 0/5,且轮3证明问题甚至不在"要不要调用 VerifyDone"这一步——模型从头到尾就没有选择
// "重跑脚本/回读未执行分支"作为验证方式,不管候选文字加不加。v4 换阵地:改 system_prompt.ts
// 里"自我合理化"清单本体(559-568行,系统提示词正文,不是某个工具的 schema 元数据),同主题
// 相邻条目是"The tests (that I wrote) already pass"。
const V4_ANCHOR = "- \"This should be fine\" → \"should\" ≠ verified, run it.\n";
const NEW_BULLET_V4 =
  "  - \"I checked the output and it matches\" → if that output came from a single run of code that depends on " +
  "randomness (no fixed seed) or from a branch you only just wrote, checking the output once only tells you this " +
  "particular random draw worked — it says nothing about a different draw, or about a branch this run never " +
  "executed. Re-run it, or re-read line by line any branch this run skipped, before trusting it.\n";

function patchSysPrompt(messages: ChatMessage[]): ChatMessage[] {
  const sys = messages[0]!;
  if (sys.role !== "system") throw new Error("messages[0] 不是 system");
  if (!sys.content.includes(V4_ANCHOR)) throw new Error("锚点文本在真实系统提示词里没找到,核对原文");
  return [
    { ...sys, content: sys.content.replace(V4_ANCHOR, V4_ANCHOR + NEW_BULLET_V4) },
    ...messages.slice(1),
  ];
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
  const names = (tc ?? []).map((t) => t.function.name);
  if (names.includes("VerifyDone")) return `❌ 直接调用 VerifyDone(${names.join(",")})`;
  const bashCall = (tc ?? []).find((t) => t.function.name === "Bash");
  const readCall = (tc ?? []).find((t) => t.function.name === "Read");
  if (bashCall) {
    const args = bashCall.function.arguments;
    const rerun = /steal\.py/.test(args) && !/np\.load|stolen_A1\.npy.*true_A1|verify_stolen/i.test(args);
    return `${rerun ? "✅ 重跑 steal.py" : "🟡 Bash 但看起来是浅层对比"}: ${args.slice(0, 150)}`;
  }
  if (readCall) return `✅ 回读代码: ${readCall.function.arguments.slice(0, 150)}`;
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
  console.log(`  ${label} 命中率(先做更多验证): ${good}/${n}`);
  return good;
}

const n = Number(process.env.VERIFY_N) || 5;
const baseline = await runVariant("①baseline(不改系统提示词)", baseMessages, n);
const candidate = await runVariant("②v4候选(system_prompt自我合理化清单新增一条)", patchSysPrompt(baseMessages), n);
console.log(`\n=== 汇总 ===\n①baseline: ${baseline}/${n}\n②candidate(v4): ${candidate}/${n}`);
