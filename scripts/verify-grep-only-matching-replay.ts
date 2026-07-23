// 快速验证(不进 harbor/docker):复原 sanitize-git-repo 真实卡点的完整历史上下文
// (state.json messages[0..46],真实截断的 Grep 命中刚出现、模型还没决定下一步这个点),
// 换上当前代码新加的 Grep only_matching 工具描述,连续跑两步:
//   第 1 步:直接问模型"接下来怎么做"(单次 completion)。
//   第 2 步:真实执行模型这次选的 Grep 调用(用重构的、贴近真实内容的文件,让 grepFilesTool
//           的代码真的跑一遍,不是手写假数据),把真实工具输出喂回去,再问一次"再接下来怎么做",
//           看模型有没有在见到"该行共 N 字符,已截断"这个新增的显式提示后,主动换成 only_matching。
//   跑:VOLCENGINE_API_KEY=... npx tsx scripts/verify-grep-only-matching-replay.ts <state.json路径>
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { streamChat } from "../src/client/client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { readFileTool } from "../src/tools/read_file.js";
import { listDirTool } from "../src/tools/list_dir.js";
import { writeFileTool } from "../src/tools/write_file.js";
import { editFileTool } from "../src/tools/edit_file.js";
import { multiEditTool } from "../src/tools/multi_edit.js";
import { execShellTool } from "../src/tools/exec_shell.js";
import { grepFilesTool } from "../src/tools/grep_files.js";
import { fileSearchTool } from "../src/tools/file_search.js";
import { todoWriteTool } from "../src/tools/todo_write.js";
import type { ChatMessage, ToolCall } from "../src/client/types.js";

const apiKey = process.env.VOLCENGINE_API_KEY ?? "";
const baseUrl = "https://ark.cn-beijing.volces.com/api/coding/v3";
const model = "deepseek-v4-pro";
if (!apiKey) { console.error("需要 VOLCENGINE_API_KEY。"); process.exit(1); }

const statePath = process.argv[2];
if (!statePath) { console.error("用法: verify-grep-only-matching-replay.ts <state.json路径>"); process.exit(1); }

const state = JSON.parse(await fs.readFile(statePath, "utf8")) as { messages: ChatMessage[] };
const CUT = 47; // 真实历史里"截断的 Grep 命中"这条 tool 结果刚出现(index 46),模型还没决定下一步
const messages: ChatMessage[] = state.messages.slice(0, CUT);

const registry = new ToolRegistry();
for (const t of [
  readFileTool, listDirTool, writeFileTool, editFileTool, multiEditTool,
  execShellTool, grepFilesTool, fileSearchTool, todoWriteTool,
]) registry.register(t);
const tools = registry.toApiTools(undefined, "en");

async function complete(msgs: ChatMessage[]) {
  const gen = streamChat({ baseUrl, apiKey, provider: "volcengine", model, messages: msgs, tools });
  let result;
  while (true) {
    const { value, done } = await gen.next();
    if (done) { result = value; break; }
  }
  return result;
}

function hasOnlyMatching(tc: ToolCall[] | undefined): ToolCall | undefined {
  return (tc ?? []).find((t) => t.function.name === "Grep" && /"only_matching"\s*:\s*true/.test(t.function.arguments));
}

console.error(`[verify] 第 1 步:回放 ${messages.length} 条历史消息(截至真实 index ${CUT - 1}),新版 Grep 工具集,发一次 completion…\n`);
const step1 = await complete(messages);
console.log("=== 第 1 步补全结果 ===");
console.log("content:", step1.content);
for (const tc of step1.tool_calls ?? []) console.log(`  tool_call: ${tc.function.name}(${tc.function.arguments})`);

const step1OnlyMatching = hasOnlyMatching(step1.tool_calls);
if (step1OnlyMatching) {
  console.log("\n✅ 第 1 步就直接选中 only_matching,无需第 2 步。");
  process.exit(0);
}

const grepCall = (step1.tool_calls ?? []).find((t) => t.function.name === "Grep");
if (!grepCall) {
  console.log("\n(第 1 步没有调用 Grep,无法继续第 2 步——如实报告,不编造。)");
  process.exit(0);
}

// ---- 第 2 步:真实执行模型选的这次 Grep 调用 ----
// 用贴近真实内容重构一份工作区:message 46/48 里能看到的真实前缀原样保留,后面接一段填充
// 撑到跟历史上模型自己读到的"该行共 21393 字符"数量级一致,再在填充里嵌入真实任务里
// 泄露的那个 HuggingFace token 极其周边上下文(pytest 失败输出里逐字给出的原文)。
// 这是真的跑 grepFilesTool.handler,不是手写一句假的工具返回。
const REAL_PREFIX =
  'diff --git a/eval/eval_openlm_ckpt.py b/eval/eval_openlm_ckpt.py\\nindex 5a9a662..c095b10 100644\\n' +
  '--- a/eval/eval_openlm_ckpt.py\\n+++ b/eval/eval_openlm_ckpt.py\\n@@ -334,6 +334,7 @@ def main():\\n' +
  '         )\\n     else:\\n         params = create_params(args)\\n+        print(f\\"{params=}\\")\\n';
const FILLER = 'x'.repeat(20500); // 撑到跟历史上"21393 字符"同量级,不追求逐字节还原(不影响机制验证)
const REAL_TOKEN_CONTEXT =
  "+    - echo 'export HF_TOKEN=hf_REDACTED_TEST_FIXTURE_TOKEN' >> ~/.bashrc\\n" +
  "+    - mkdir -p ~/.cache/huggingface/\\n" +
  "+    - echo 'hf_REDACTED_TEST_FIXTURE_TOKEN' > ~/.cache/huggingface/token\\n" +
  "     - pip install --upgrade pip setuptools wheel\\n";
const diffValue = REAL_PREFIX + FILLER + REAL_TOKEN_CONTEXT;

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dao-sanitize-replay-"));
const targetDir = path.join(tmpRoot, "exp_data", "datasets", "tokenized");
await fs.mkdir(targetDir, { recursive: true });
const targetFile = path.join(targetDir, "rw_v2_fasttext_openhermes_vs_rw_v2_bigram_0.1_arcade100k.json");
const fileContent =
  "{\n" +
  '    "uuid": "x",\n' +
  '    "num_tokens": 28710999849,\n' +
  '    "size": 78340828843,\n' +
  '    "dcnlp_commit_hash": "8b6471e8473b4c1140e505b09ae8163c17abd994",\n' +
  `    "dcnlp_diff": "${diffValue}",\n` +
  '    "data_key": "json.gz",\n' +
  '    "sampling_yaml": null\n' +
  "}\n";
await fs.writeFile(targetFile, fileContent, "utf8");

const rawArgs = JSON.parse(grepCall.function.arguments) as Record<string, unknown>;
console.error(`\n[verify] 第 2 步:真实执行模型选的调用 Grep(${JSON.stringify(rawArgs)}),对象是重构的贴近真实内容的文件…`);
const toolResult = await grepFilesTool.handler(
  { pattern: rawArgs.pattern as string, path: "exp_data", ...(rawArgs.glob ? { glob: rawArgs.glob as string } : {}) },
  { workspaceRoot: tmpRoot, cwd: tmpRoot } as any,
);
console.log("\n=== 真实 Grep 工具输出(喂回给模型的内容)===");
console.log(toolResult);

const messages2: ChatMessage[] = [
  ...messages,
  { role: "assistant", content: step1.content, tool_calls: step1.tool_calls },
  { role: "tool", tool_call_id: grepCall.id, content: toolResult },
];

console.error("\n[verify] 发第 2 次 completion,看模型见到显式截断提示后会不会换 only_matching…\n");
const step2 = await complete(messages2);
console.log("=== 第 2 步补全结果 ===");
console.log("content:", step2.content);
for (const tc of step2.tool_calls ?? []) console.log(`  tool_call: ${tc.function.name}(${tc.function.arguments})`);

const step2OnlyMatching = hasOnlyMatching(step2.tool_calls);
console.log("\n最终判读:");
console.log(
  step2OnlyMatching
    ? `✅ 见到显式截断提示后,第 2 步模型主动换成了 only_matching:${step2OnlyMatching.function.arguments}`
    : "❌ 即便见到显式截断提示,模型这次仍未选 only_matching",
);

await fs.rm(tmpRoot, { recursive: true, force: true });
