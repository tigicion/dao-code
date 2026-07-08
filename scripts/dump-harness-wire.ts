// 生成 docs/harness/wire/*.wire.{md,json}:真实拼装出"最终要发给 LLM 接口的内容"
// (system prompt 全文、tools 的 JSON Schema、以及嵌入 system prompt 里的技能目录/子代理清单/记忆段落)。
//
// 用真实的本仓库 workspaceRoot + 真实的 ~/.dao 数据(记忆/技能/自定义子代理)跑一遍 index.ts 里
// 组装 systemPrompt 的同一段逻辑(不 import index.ts 本身——它是交互式 CLI 入口,直接 import 会拉起整个程序)。
// 跑法:npm run debug:harness-wire
//
// 这是快照,不是恒定不变的文档:记忆/技能会随时间变化,重跑本脚本即可刷新 docs/harness/wire/。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { ToolRegistry } from "../src/tools/registry.js";
import { readFileTool } from "../src/tools/read_file.js";
import { listDirTool } from "../src/tools/list_dir.js";
import { writeFileTool } from "../src/tools/write_file.js";
import { editFileTool } from "../src/tools/edit_file.js";
import { multiEditTool } from "../src/tools/multi_edit.js";
import { notebookEditTool } from "../src/tools/notebook_edit.js";
import { execShellTool } from "../src/tools/exec_shell.js";
import { execShellPollTool } from "../src/tools/exec_shell_poll.js";
import { execShellKillTool } from "../src/tools/exec_shell_kill.js";
import { grepFilesTool } from "../src/tools/grep_files.js";
import { fileSearchTool } from "../src/tools/file_search.js";
import { askUserTool } from "../src/tools/ask_user.js";
import { fetchUrlTool } from "../src/tools/fetch_url.js";
import { webSearchTool } from "../src/tools/web_search.js";
import { todoWriteTool } from "../src/tools/todo_write.js";
import { memoryWriteTool } from "../src/tools/memory_write.js";
import { memoryReadTool } from "../src/tools/memory_read.js";
import { verifyDoneTool } from "../src/tools/verify.js";
import { skillTool } from "../src/tools/skill.js";
import { skillInstallTool } from "../src/tools/skill_install.js";
import { taskSendTool } from "../src/tools/task_send.js";
import { messageParentTool } from "../src/tools/message_parent.js";
import { agentTool } from "../src/tools/agent.js";
import { scheduleTool } from "../src/tools/schedule_tool.js";

import { buildSystemPrompt } from "../src/prompt/system_prompt.js";
import { loadProjectInstructions } from "../src/project_doc.js";
import { loadAgentDefs } from "../src/agent/agent_defs.js";
import { BUNDLED_AGENTS } from "../src/agent/bundled_agents.js";
import { loadSkills, skillCatalogLines, type Skill } from "../src/skills/skills.js";
import { BUNDLED_SKILLS } from "../src/skills/bundled.js";
import { loadAllMemories, routeScope, keepKnowledgeForProject, projectIdOf } from "../src/memory/store.js";
import { validateMemory, type Verdict } from "../src/memory/validate.js";
import { buildMemorySection, buildIndexSection, selectFullText, selectIndexNames } from "../src/memory/inject.js";
import { CHALLENGER_PROMPT, REFOCUSER_PROMPT, SELF_CHALLENGE_NUDGE } from "../src/agent/reflect_prompts.js";

const workspaceRoot = process.cwd();
const outDir = path.join(workspaceRoot, "docs", "harness", "wire");
mkdirSync(outDir, { recursive: true });

async function main() {
  const lang = "zh" as const;

  // ---- 工具注册表(和 index.ts:433-439 相同的 24 个内建工具) ----
  const registry = new ToolRegistry();
  for (const t of [
    readFileTool, listDirTool, writeFileTool, editFileTool, multiEditTool, notebookEditTool,
    execShellTool, execShellPollTool, execShellKillTool,
    grepFilesTool, fileSearchTool, askUserTool, fetchUrlTool, webSearchTool, todoWriteTool,
    memoryWriteTool, memoryReadTool, verifyDoneTool, skillTool, skillInstallTool,
    taskSendTool, messageParentTool, agentTool, scheduleTool,
  ]) registry.register(t);

  const apiTools = registry.toApiTools(undefined, lang);
  writeFileSync(path.join(outDir, "tools.wire.json"), JSON.stringify(apiTools, null, 2));

  const toolSummaries = apiTools.map((t) => `- ${t.function.name}:${t.function.description}`).join("\n");

  // ---- 记忆(真实读本仓库 .dao/memory + 真实用户 ~/.dao/memory + ~/.dao/knowledge) ----
  const projectMemoryDir = path.join(workspaceRoot, ".dao", "memory");
  const userMemoryDir = path.join(os.homedir(), ".dao", "memory");
  const knowledgeMemoryDir = path.join(os.homedir(), ".dao", "knowledge");
  const today = new Date().toISOString().slice(0, 10);
  const projectId = projectIdOf(workspaceRoot);
  const localMems = await loadAllMemories(projectMemoryDir, userMemoryDir);
  const knowAll = await loadAllMemories(knowledgeMemoryDir);
  const knowKept = knowAll.filter((m) => keepKnowledgeForProject(m, projectId));
  const memories = [...localMems, ...knowKept];
  const validated: { mem: (typeof memories)[number]; verdict: Verdict }[] = [];
  for (const mem of memories) {
    const { verdict } = await validateMemory(mem, workspaceRoot, today);
    validated.push({ mem, verdict });
  }
  const SMALL_N = 50;
  const liveCount = validated.filter((v) => v.verdict !== "stale").length;
  let injectedMems: typeof validated; let indexNames: string[];
  if (liveCount < SMALL_N) {
    injectedMems = selectFullText(validated, today, SMALL_N); indexNames = [];
  } else {
    injectedMems = selectFullText(validated, today);
    indexNames = selectIndexNames(validated, today, injectedMems);
  }
  const memoryText = buildMemorySection(injectedMems) + buildIndexSection(indexNames);
  writeFileSync(
    path.join(outDir, "memory.wire.md"),
    `<!-- 这是 buildSystemPrompt 的 {memory} 占位符实际填入的内容,真实生成于 ${today}(本仓库 + 你的 ~/.dao)。 -->\n\n` +
      "```text\n" + memoryText + "\n```\n",
  );

  // ---- 子代理类型(真实内置 + 本仓库 .dao/agents,若有) ----
  const diskAgentDefs = await loadAgentDefs(
    path.join(workspaceRoot, ".dao", "agents"),
    path.join(os.homedir(), ".dao", "agents"),
    [],
  );
  const diskAgentNames = new Set(diskAgentDefs.map((d) => d.name));
  const agentDefs = [...diskAgentDefs, ...BUNDLED_AGENTS.filter((a) => !diskAgentNames.has(a.name))];
  const agentTypesHeader = "\n\n# 可用子代理类型(派 agent 时用 agent_type 指定,各有专属角色与工具)\n";
  const agentTypesSection = agentDefs.length > 0
    ? agentTypesHeader + agentDefs.map((d) => `- ${d.name}:${d.description}`).join("\n")
    : "";
  writeFileSync(
    path.join(outDir, "subagents.wire.md"),
    "<!-- 这段文本被直接拼在 systemPrompt 末尾(见 system-prompt.wire.md 的对应小节)。 -->\n\n" +
      "```text\n" + agentTypesSection + "\n```\n\n" +
      "## 各内置子代理类型的专属角色 prompt(派发时追加在完整 systemPrompt 之后)\n\n" +
      agentDefs.map((d) => `### ${d.name}\n\n\`\`\`text\n${d.prompt}\n\`\`\`\n`).join("\n"),
  );

  // ---- 技能(真实内置 8 个 + 本仓库/用户磁盘技能,若有) ----
  const diskSkills = [
    ...(await loadSkills(path.join(os.homedir(), ".dao", "skills"), path.join(workspaceRoot, ".dao", "skills"))),
  ];
  const coreBundled: Skill[] = BUNDLED_SKILLS
    .filter((b) => b.core)
    .map((b) => ({ name: b.name, description: b.description, body: b.body, dir: "", slug: b.name }));
  const skills = [...coreBundled, ...diskSkills];
  const skillsHeader =
    `\n\n# 可用 skill —— 开始任何任务前先扫这张表\n` +
    `【强制要求】只要某个 skill 可能与当前任务相关(哪怕只有一点可能,尤其其"何时用"写明"在…之前/必须用"的——` +
    `这类标了【触发时机】的,匹配上就该先加载),就【必须先用 skill 工具加载它、照它做,再做其它任何回应或动作】——` +
    `包括在澄清提问之前。别凭感觉直接上手而跳过它,也别只提技能名却不调用。\n` +
    `加载后,skill 正文是【必须照做的流程】(含其中"给用户选项/确认/分阶段"的步骤),不是参考——优先级高于你的默认习惯,仅让位于用户当前明确指令与安全/证据。\n`;
  const skillsSection = skills.length > 0 ? skillsHeader + skillCatalogLines(skills) : "";
  writeFileSync(
    path.join(outDir, "skills.wire.md"),
    "<!-- 这段文本被直接拼在 systemPrompt 末尾(见 system-prompt.wire.md 的对应小节)。这是 L1 目录层;\n" +
      "     L2 正文层(某 skill 被 `skill` 工具实际调用时追加到对话尾部的内容)不在这里,是每个 SKILL.md 的原文。 -->\n\n" +
      "```text\n" + skillsSection + "\n```\n",
  );

  // ---- 系统提示词全文(BODY + agentTypesSection + skillsSection) ----
  const systemPrompt =
    buildSystemPrompt({
      modelId: "deepseek-v4-pro",
      toolSummaries,
      memories: memoryText,
      cwd: workspaceRoot,
      platform: process.platform,
      projectInstructions: loadProjectInstructions(workspaceRoot),
      lang,
    }) + agentTypesSection + skillsSection;
  writeFileSync(
    path.join(outDir, "system-prompt.wire.md"),
    `<!-- 真实生成于 ${today}(本仓库 + 你的 ~/.dao),约 ${systemPrompt.length} 字符。` +
      ` 由 buildSystemPrompt(...) + agentTypesSection + skillsSection 拼成,即 messages[0] 的完整 system 消息内容。 -->\n\n` +
      "```text\n" + systemPrompt + "\n```\n",
  );

  // ---- 中间件类的"最终 wire 内容":静态模板本身是确定的,动态部分(诊断输出/verdict 文本)留占位说明 ----
  const middlewareWire = `# 中间件(横切执行控制)在对话里实际追加的消息模板

这些不是像 system prompt 那样"启动定一次进前缀",而是**运行中按时机追加到对话尾部**的 \`{role:"system"}\` 消息。
以下是各模板的真实字面文本(取自代码常量,未做任何改写),\`<...>\` 处是运行时才知道的动态内容。

## 编辑后诊断回灌(\`src/agent/loop.ts\`,写文件类工具调用后触发)

\`\`\`text
[诊断:编辑后检查发现问题,请修复]
<lint/tsc 等诊断工具的真实输出>
\`\`\`

## 进度提醒(\`src/agent/loop.ts\`,连续 N 轮无实质推进)

\`\`\`text
[进度提醒] 已连续 <N> 轮没有改动文件或推进任务清单。回看 todo 确认方向;若已完成请调用 verify_done 收尾;若卡住请换思路或用 ask_user 向用户求助,不要空转。
\`\`\`

## 轮数提醒(\`src/agent/loop.ts\`,进入最后 5 轮时触发一次)

\`\`\`text
[轮数提醒] 接近最大轮数(<t+1>/<maxTurns>),请尽快收敛并收尾(必要时 verify_done 验收或向用户汇报现状)。
\`\`\`

## 审视者 / 纠偏者 advisory(\`src/agent/loop.ts\` 消费 \`deps.reflect()\` 返回值)

多条 advisory 会用空格 join 成【一条】system 消息追加进对话:

\`\`\`text
[审视者]
<challenger fork 独立视角复核后的结论文本,由下面的 CHALLENGER_PROMPT 驱动产出>
\`\`\`

或

\`\`\`text
[纠偏者]
<refocuser fork 独立视角复核后的结论文本,由下面的 REFOCUSER_PROMPT 驱动产出>
\`\`\`

驱动这两个 fork 的真实 prompt 原文(\`src/agent/reflect_prompts.ts\`):

### CHALLENGER_PROMPT

\`\`\`text
${CHALLENGER_PROMPT}
\`\`\`

### REFOCUSER_PROMPT

\`\`\`text
${REFOCUSER_PROMPT}
\`\`\`

## 子代理自省 nudge(仅子代理,连续失败/同错复发时注入自己的上下文,不 fork)

\`\`\`text
${SELF_CHALLENGE_NUDGE}
\`\`\`

## 压缩产出的摘要消息(\`src/agent/compact.ts\`,替换旧对话)

首次压缩:

\`\`\`text
[早期对话摘要——上下文超限已压缩,以下是早段对话的摘要]
<独立一次 streamChat 生成的摘要文本>

从中断处直接继续,不要复述摘要、不要寒暄,像没中断过一样接着上一个任务。
\`\`\`

再次压缩(增量,旧摘要原样保留):

\`\`\`text
<上一次的摘要原文>

[续·本次新增]
<本次新增部分的摘要文本>
\`\`\`

摘要生成失败降级(熔断器打开时):

\`\`\`text
<既有摘要(若有)>

[早期对话已截断(摘要暂不可用):为继续任务保留了系统提示与任务清单,对话细节已舍弃。如缺关键背景,请向用户确认。]
\`\`\`

压缩后重注入的活任务清单 pin:

\`\`\`text
[当前任务清单(请据此继续,勿偏离)]
<todo_write 当前状态的文本快照>
\`\`\`

## Hook additionalContext(\`src/tools/execute.ts\`,PreToolUse hook 返回值,附在【工具结果】而非 system 消息里)

\`\`\`text
<工具真实返回内容>
[hook 提示] <hook 脚本 stdout JSON 里的 additionalContext 字段>
\`\`\`
`;
  writeFileSync(path.join(outDir, "middleware.wire.md"), middlewareWire);

  console.log(`已写入 ${outDir}/*.wire.{md,json}`);
  console.log(`system-prompt.wire.md: ${systemPrompt.length} 字符`);
  console.log(`tools.wire.json: ${apiTools.length} 个工具`);
  console.log(`memory 注入条数: ${injectedMems.length}(索引 ${indexNames.length} 条),来自 ${memories.length} 条候选`);
  console.log(`skills 目录条数: ${skills.length}`);
  console.log(`agent 类型数: ${agentDefs.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
