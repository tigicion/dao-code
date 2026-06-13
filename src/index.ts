#!/usr/bin/env node
import { createInterface, type Interface } from "node:readline/promises";
import { readFileSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { readConfig } from "./config/config.js";
import { loadDotenv } from "./config/env_file.js";
import { loadStoredKey, saveKey } from "./config/key_store.js";
import { migrateLegacyDir } from "./config/migrate_dirs.js";
import { streamChat } from "./client/client.js";
import { runTurn } from "./agent/loop.js";
import { executeToolCalls } from "./tools/execute.js";
import { ToolRegistry } from "./tools/registry.js";
import { readFileTool } from "./tools/read_file.js";
import { listDirTool } from "./tools/list_dir.js";
import { writeFileTool } from "./tools/write_file.js";
import { editFileTool } from "./tools/edit_file.js";
import { multiEditTool } from "./tools/multi_edit.js";
import { notebookEditTool } from "./tools/notebook_edit.js";
import { installSkills } from "./skills/install.js";
import { scheduleAdd, scheduleList, scheduleRemove } from "./schedule.js";
import { scheduleTool } from "./tools/schedule_tool.js";
import { loadPlugins, installPlugin, removePlugin, pluginsRoot } from "./plugins.js";
import { execShellTool } from "./tools/exec_shell.js";
import { execShellPollTool } from "./tools/exec_shell_poll.js";
import { execShellKillTool } from "./tools/exec_shell_kill.js";
import { grepFilesTool } from "./tools/grep_files.js";
import { fileSearchTool } from "./tools/file_search.js";
import { askUserTool } from "./tools/ask_user.js";
import { fetchUrlTool } from "./tools/fetch_url.js";
import { webSearchTool } from "./tools/web_search.js";
import { todoWriteTool } from "./tools/todo_write.js";
import { memoryWriteTool } from "./tools/memory_write.js";
import { memorySearchTool } from "./tools/memory_search.js";
import { verifyDoneTool } from "./tools/verify.js";
import { runSubagent } from "./agent/subagent.js";
import { createTaskManager } from "./agent/tasks.js";
import { loadAgentDefs } from "./agent/agent_defs.js";
import { createWorktree } from "./agent/worktree.js";
import { loadCustomCommands, expandCommand } from "./commands/custom.js";
import { loadSkills } from "./skills/skills.js";
import { BUNDLED_SKILLS } from "./skills/bundled.js";
import { skillTool } from "./tools/skill.js";
import { taskSendTool } from "./tools/task_send.js";
import { loadHooks, runHooks } from "./hooks/hooks.js";
import { loadMcpConfig, connectMcpServers } from "./mcp/mcp.js";
import { processManager } from "./tools/process_manager.js";
import { agentTool } from "./tools/agent.js";
import { loadAllMemories, upsertMemory, migrateLegacy } from "./memory/store.js";
import { validateMemory, type Verdict } from "./memory/validate.js";
import { buildMemorySection, selectForInjection } from "./memory/inject.js";
import { gcMemories } from "./memory/gc.js";
import { distill } from "./memory/distill.js";
import { makeFlashAdjudicator } from "./memory/adjudicate.js";
import type { ApprovalGate } from "./approval/types.js";
import { makeApprovalPrompt } from "./approval/stdin_prompt.js";
import { loadAlwaysApproved, appendAlwaysApproved } from "./approval/store.js";
import { PermissionGate } from "./permissions/gate.js";
import { loadPermissions, mergePermissions, appendRule, enterpriseSettingsPath, extractCliPermissions, type PermissionMode } from "./permissions/settings.js";
import { buildSystemPrompt, LONG_TASK_DIRECTIVE, COORDINATOR_DIRECTIVE } from "./prompt/system_prompt.js";
import { Session } from "./session/session.js";
import { createSessionStore, logEvents, findResumable, loadState } from "./session/log.js";
import { createCheckpointer } from "./session/checkpoint.js";
import { runRepl } from "./repl.js";
import { dispatchCommand } from "./commands/commands.js";
import { runBuiltinCommand } from "./commands/builtin.js";
import { buildWelcome } from "./tui/banner.js";
import { detectCapabilities } from "./tui/capabilities.js";
import { resolveBackground } from "./tui/background.js";
import { randomMaxim } from "./tui/maxim.js";
import { runInkApp } from "./tui/app/run.js";
import { walkFiles } from "./tools/walk.js";
import type { ApprovalPrompt } from "./approval/types.js";
import { VERSION } from "./version.js";
import { compactMessages, shouldCompact, estimateTokens } from "./agent/compact.js";
import { todoStore, formatTodos } from "./tools/todo_store.js";
import type { ChatMessage } from "./client/types.js";
import type { ToolContext } from "./tools/types.js";
import type { TranscriptItem } from "./tui/app/types.js";

// 续跑时,把历史消息重建成可见的 transcript(只回放 user/assistant 文本;工具细节在日志里)。
function transcriptFromMessages(messages: ChatMessage[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  let id = 1;
  for (const m of messages) {
    if (m.role === "user" && typeof m.content === "string") out.push({ id: id++, kind: "user", text: m.content });
    else if (m.role === "assistant" && typeof m.content === "string" && m.content.trim())
      out.push({ id: id++, kind: "assistant", text: m.content });
  }
  return out;
}

const KEY_HELP =
  "获取 key:https://platform.deepseek.com/api_keys";

async function main() {
  // 退出/中断时清理所有后台进程,避免孤儿(长任务里模型常起 dev server/watch)。
  let cleaned = false;
  const cleanup = () => { if (!cleaned) { cleaned = true; try { processManager.reset(); } catch {} } };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });

  const rawArgs = process.argv.slice(2);
  // --version/-v 必须在任何初始化(读配置/连 API)之前拦下,否则整句会被当 prompt 发给模型。
  if (rawArgs.includes("--version") || rawArgs.includes("-v")) {
    process.stdout.write(`dao-code v${VERSION}\n`);
    return;
  }
  // 操作员命令:dao schedule add|list|remove —— 本地 OS crontab 定时跑 headless dao。不连 API。
  if (rawArgs[0] === "schedule") {
    const sub = rawArgs[1];
    const w = (s: string) => process.stdout.write(s);
    try {
      if (sub === "add") {
        const cron = rawArgs[2], prompt = rawArgs.slice(3).join(" ");
        if (!cron || !prompt) { process.stderr.write('用法:dao schedule add "<cron 5 字段>" "<prompt>"\n'); process.exit(1); }
        await scheduleAdd(cron, prompt, process.cwd(), process.execPath, w);
      } else if (sub === "list") {
        await scheduleList(w);
      } else if (sub === "remove") {
        await scheduleRemove(Number(rawArgs[2]), w);
      } else {
        process.stderr.write("用法:dao schedule <add \"<cron>\" \"<prompt>\" | list | remove <n>>\n");
        process.exit(1);
      }
    } catch (e) { process.stderr.write(`schedule 失败:${(e as Error).message}\n`); process.exit(1); }
    return;
  }
  // 操作员命令:dao plugin add|list|remove —— 插件(打包 skills,~/.dao/plugins/<名>/)。不连 API。
  if (rawArgs[0] === "plugin") {
    const sub = rawArgs[1];
    const w = (s: string) => process.stdout.write(s);
    try {
      if (sub === "add" && rawArgs[2]) await installPlugin(rawArgs[2], w);
      else if (sub === "list") {
        const ps = await loadPlugins();
        w(ps.length ? "已装插件:\n" + ps.map((p) => `  ${p.name} — ${p.description}`).join("\n") + "\n" : "未装任何插件。\n");
      } else if (sub === "remove" && rawArgs[2]) await removePlugin(rawArgs[2], w);
      else { process.stderr.write("用法:dao plugin <add <git-url|路径> | list | remove <名>>\n"); process.exit(1); }
    } catch (e) { process.stderr.write(`plugin 失败:${(e as Error).message}\n`); process.exit(1); }
    return;
  }
  // 操作员命令:dao skill add <git-url|本地路径> [--user|--project]。不连 API,装完即退。
  if (rawArgs[0] === "skill" && rawArgs[1] === "add") {
    const rest = rawArgs.slice(2);
    const source = rest.find((a) => !a.startsWith("--"));
    const scope: "user" | "project" = rest.includes("--project") ? "project" : "user"; // 默认用户级(技能多为通用)
    if (!source) { process.stderr.write("用法:dao skill add <git-url|本地路径> [--user|--project]\n"); process.exit(1); }
    try {
      await installSkills(source, scope, process.cwd(), (s) => process.stdout.write(s));
    } catch (e) {
      process.stderr.write(`安装失败:${(e as Error).message}\n`);
      process.exit(1);
    }
    return;
  }
  const yoloFlag = rawArgs.includes("--yolo");
  const continueFlag = rawArgs.includes("--continue") || rawArgs.includes("-c");
  const taskFlag = rawArgs.includes("--task");
  const coordinatorFlag = rawArgs.includes("--coordinator");
  const verbose = rawArgs.includes("--verbose") || rawArgs.includes("--debug");
  const flags = new Set(["--yolo", "--continue", "-c", "--task", "--coordinator", "--verbose", "--debug"]);
  // 先抽取 CLI 权限规则/模式(--allow/--deny/--add-dir/--permission-mode),其余再去掉布尔 flag 作 prompt。
  const { config: cliPerms, rest: argsAfterPerms } = extractCliPermissions(rawArgs);
  const argvPrompt = argsAfterPerms.filter((a) => !flags.has(a)).join(" ").trim();
  const workspaceRoot = process.cwd();
  // codeds → DAO CODE 改名:一次性把旧 .codeds/ 数据(项目级+用户级)整体迁到 .dao/。
  // 必须在任何 .dao 路径被读写之前做;失败不阻塞启动(等价于全新环境)。
  for (const base of [workspaceRoot, os.homedir()]) {
    const r = await migrateLegacyDir(path.join(base, ".codeds"), path.join(base, ".dao")).catch(() => "absent" as const);
    if (r === "migrated") process.stdout.write(`✓ 已迁移旧数据:${path.join(base, ".codeds")} → ${path.join(base, ".dao")}\n`);
  }
  const approvalsFile = path.join(workspaceRoot, ".dao", "approvals.json");
  const keyFile = path.join(os.homedir(), ".dao", "config.json");

  const write = (s: string) => process.stdout.write(s);

  // 背景(亮/暗)检测:env 显式(DAO_THEME/COLORFGBG)> OSC 11 向终端查背景色 > 默认 dark。
  // 在 readline(懒创建)与 Ink 之前做,stdin 干净;OSC 完成即恢复。非 TTY 立即回退,不阻塞 eval。
  const bg = await resolveBackground(process.env);

  // 懒创建 readline:仅「key 引导 / 非 TTY 纯文本 REPL」需要。
  // Ink 交互态绝不创建 readline——readline 会接管 stdin,其 create+close 周期会破坏 stdin 状态,
  // 导致 Ink 接管后立刻收到 EOF/退出(表现为渲染一帧就退回 shell)。不碰它,Ink 的 useInput keep-alive 才正常。
  let rl: Interface | null = null;
  const lineQueue: string[] = [];
  const lineWaiters: Array<(line: string | null) => void> = [];
  let rlClosed = false;
  const ensureRl = () => {
    if (rl) return rl;
    rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on("line", (line) => {
      const w = lineWaiters.shift();
      if (w) w(line);
      else lineQueue.push(line);
    });
    rl.on("close", () => {
      rlClosed = true;
      for (const w of lineWaiters) w(null);
      lineWaiters.length = 0;
    });
    return rl;
  };
  const closeRl = () => {
    if (rl) rl.close();
  };
  const nextLine = (): Promise<string | null> => {
    ensureRl();
    if (lineQueue.length) return Promise.resolve(lineQueue.shift()!);
    if (rlClosed) return Promise.resolve(null);
    return new Promise((res) => lineWaiters.push(res));
  };
  const ask = async (prompt: string): Promise<string> => {
    write(prompt);
    const line = await nextLine();
    return line ?? "";
  };

  // ---- 解析 API key:环境变量 > 项目 .env > 已存配置 > 交互引导 ----
  const dotenv = await loadDotenv(path.join(workspaceRoot, ".env"));
  const effectiveEnv = { ...dotenv, ...process.env }; // 环境变量优先,.env 填空缺
  const raw = readConfig(effectiveEnv);
  let apiKey = raw.apiKey ?? (await loadStoredKey(keyFile));

  if (!apiKey) {
    if (process.stdin.isTTY) {
      // 真终端:引导用户粘贴 key,并可一次性保存
      write(`\n未检测到 DeepSeek API key。\n${KEY_HELP}\n`);
      const entered = (await ask("请粘贴你的 key: ")).trim();
      if (!entered) {
        write("未输入 key,已退出。\n");
        closeRl();
        process.exit(1);
      }
      apiKey = entered;
      const saveAns = (await ask(`是否保存到 ${keyFile} 方便下次免输?[Y/n] `)).trim().toLowerCase();
      if (saveAns === "" || saveAns === "y" || saveAns === "yes") {
        await saveKey(keyFile, apiKey);
        write(`✓ 已保存(下次直接可用)。\n`);
      }
    } else {
      // 非交互(管道/CI):无法引导,给出清晰指引后退出
      console.error(
        [
          "未找到 DeepSeek API key。请用以下任一方式设置:",
          "  • 环境变量:export DEEPSEEK_API_KEY=sk-...",
          "  • 项目 .env:在 .env 写一行 DEEPSEEK_API_KEY=sk-...",
          "  • 在终端直接运行 dao(不接管道),会引导你粘贴并保存 key",
          KEY_HELP,
        ].join("\n"),
      );
      closeRl();
      process.exit(1);
    }
  }

  const cfg = { apiKey: apiKey!, baseUrl: raw.baseUrl, model: raw.model };

  const registry = new ToolRegistry();
  for (const t of [
    readFileTool, listDirTool, writeFileTool, editFileTool, multiEditTool, notebookEditTool,
    execShellTool, execShellPollTool, execShellKillTool,
    grepFilesTool, fileSearchTool, askUserTool, fetchUrlTool, webSearchTool, todoWriteTool, memoryWriteTool, memorySearchTool, verifyDoneTool, skillTool, taskSendTool, agentTool, scheduleTool,
  ]) {
    registry.register(t);
  }

  // MCP:连配置的 server,把其工具注册进来(名字 mcp__server__tool)。失败的 server 不影响其余/启动。
  const mcpConfig = await loadMcpConfig([
    path.join(os.homedir(), ".dao", "mcp.json"),
    path.join(workspaceRoot, ".dao", "mcp.json"),
  ]);
  const mcp = await connectMcpServers(mcpConfig);
  for (const t of mcp.tools) registry.register(t);

  const toolSummaries = registry
    .toApiTools()
    .map((t) => `- ${t.function.name}:${t.function.description}`)
    .join("\n");

  // ---- 记忆读路径(会话启动一次性):迁移旧 JSON → 加载 → 确定性权威验证 → 注入固定前缀 ----
  const projectMemoryDir = path.join(workspaceRoot, ".dao", "memory");
  const userMemoryDir = path.join(os.homedir(), ".dao", "memory");
  // 三层记忆:项目级(本项目事实/进展)、用户级(用户信息+偏好)、知识库(跨项目可复用技术知识 procedural)。
  const knowledgeMemoryDir = path.join(os.homedir(), ".dao", "knowledge");
  const today = new Date().toISOString().slice(0, 10);
  // 一次性把旧 memories.json 迁移成 md(已迁移则跳过;目录不存在也容错)。
  await migrateLegacy(projectMemoryDir, today);
  await migrateLegacy(userMemoryDir, today);
  // 衰减 GC:先剪掉死记忆(留存跌破阈值的低价值事实 / 过期且宽限期已过的取代项),
  // 使它们既不被加载也不被注入。确定性,无 LLM。
  await gcMemories(projectMemoryDir, today);
  await gcMemories(userMemoryDir, today);
  await gcMemories(knowledgeMemoryDir, today);
  const memories = await loadAllMemories(projectMemoryDir, userMemoryDir, knowledgeMemoryDir);
  // 逐条对照 live code 做确定性验证(stale 剔除 / changed 标注 / ok 注入)。
  const validated: { mem: (typeof memories)[number]; verdict: Verdict }[] = [];
  for (const mem of memories) {
    const { verdict } = await validateMemory(mem, workspaceRoot, today);
    validated.push({ mem, verdict });
  }
  // store 过大时按 top-K 封顶注入(user 模型必留);会话启动无 query,确定性选择。
  const memoryText = buildMemorySection(selectForInjection(validated, today));

  // 自定义子代理类型(.dao/agents/*.md):专属 prompt/工具白名单/模型。
  const agentDefs = await loadAgentDefs(
    path.join(workspaceRoot, ".dao", "agents"),
    path.join(os.homedir(), ".dao", "agents"),
  );
  // 自定义 slash 命令(.dao/commands/*.md):/name 展开成 prompt。
  const customCommands = await loadCustomCommands(
    path.join(workspaceRoot, ".dao", "commands"),
    path.join(os.homedir(), ".dao", "commands"),
  );
  const agentTypesSection =
    agentDefs.length > 0
      ? `\n\n# 可用子代理类型(派 agent 时用 agent_type 指定,各有专属角色与工具)\n` +
        agentDefs.map((d) => `- ${d.name}:${d.description}`).join("\n")
      : "";
  // 开箱即用 skill(.dao/skills/ + 已装插件的 skills/):启动只列 name+description,模型用 skill 工具按需取正文。
  const installedPlugins = await loadPlugins();
  const pluginSkills = (await Promise.all(installedPlugins.map((p) => loadSkills(p.skillsDir)))).flat();
  const diskSkills = [
    ...(await loadSkills(path.join(os.homedir(), ".dao", "skills"), path.join(workspaceRoot, ".dao", "skills"))),
    ...pluginSkills,
  ];
  const diskNames = new Set(diskSkills.map((s) => s.name));
  // 内置【核心】技能:描述固定加载进模型上下文(可自动触发),但不进用户的 /skills 列表、不可关。
  const coreBundled = BUNDLED_SKILLS.filter((b) => b.core && !diskNames.has(b.name)).map((b) => ({ ...b, dir: "" }));
  // 禁用集(~/.dao/skills-disabled.json):被禁用的【磁盘】技能不注入上下文(省 token),/skills 可开关。
  const disabledPath = path.join(os.homedir(), ".dao", "skills-disabled.json");
  const disabledSet = new Set<string>((() => { try { return JSON.parse(readFileSync(disabledPath, "utf8")); } catch { return []; } })());
  const pluginsDir = pluginsRoot();
  const skillSource = (s: { dir: string }) => (s.dir.startsWith(pluginsDir) ? "插件" : s.dir.startsWith(workspaceRoot) ? "项目" : "用户");
  const skillTokens = (s: { name: string; description: string }) => Math.max(1, Math.round((s.name.length + s.description.length) / 2));
  const enabledDisk = diskSkills.filter((s) => !disabledSet.has(s.name));
  // 模型可见 = 核心内置(固定) + 启用的磁盘技能;ctx.skills 据此,skill 工具按需加载正文。
  const skills = [...coreBundled, ...enabledDisk];
  const skillsSection =
    skills.length > 0
      ? `\n\n# 可用 skill(任务匹配时用 skill 工具加载其正文指令再照做)\n` +
        skills.map((s) => `- ${s.name}:${s.description}`).join("\n")
      : "";

  const systemPrompt =
    buildSystemPrompt({
      modelId: cfg.model,
      toolSummaries,
      memories: memoryText,
      cwd: workspaceRoot,
      platform: process.platform,
    }) + agentTypesSection + skillsSection;

  // Ink 交互态注册的审批/提问模态(App 挂载后填入);未填则回退 readline。
  let inkApprovalPrompt: ApprovalPrompt | null = null;
  let inkAsk: ((q: string) => Promise<string>) | null = null;

  // 长任务自主模式(--task / 运行时 /task):自主连续推进 + 自动批准 + 更高轮数上限。
  let longTask = taskFlag;
  // Coordinator 编排模式(--coordinator / 运行时 /coordinator):研究→综合→实现→验证多 agent 工作流。
  let coordinator = coordinatorFlag;
  // YOLO:自动批准一切写/执行(慎用)。来源:--yolo / DAO_AUTO_APPROVE / 运行时 /yolo;长任务/Coordinator 默认开。
  let yolo = yoloFlag || taskFlag || coordinatorFlag || !!process.env.DAO_AUTO_APPROVE;
  const alwaysApproved = await loadAlwaysApproved(approvalsFile);
  const readlinePrompt = makeApprovalPrompt(ask);

  // ---- CC 风格权限:分层加载 settings.json(user < project < local)----
  const localSettingsFile = path.join(workspaceRoot, ".dao", "settings.local.json");
  // 优先级(低→高):user < project < local < CLI < enterprise(企业托管策略不可被下层覆盖)。
  const lowerPerms = await loadPermissions([
    path.join(os.homedir(), ".dao", "settings.json"),
    path.join(workspaceRoot, ".dao", "settings.json"),
    localSettingsFile,
  ]);
  const enterprisePerms = await loadPermissions([enterpriseSettingsPath()]);
  const loadedPerms = mergePermissions([lowerPerms, cliPerms, enterprisePerms]);
  // 本会话临时追加的 allow 规则("session"/"always" 决定产生);always 另持久化到 local。
  const sessionAllow: string[] = [];
  const getRules = () => ({ ...loadedPerms, allow: [...loadedPerms.allow, ...sessionAllow] });
  // 运行时模式覆盖(/mode acceptEdits 等);null = 用 settings 的 defaultMode。
  let permModeOverride: PermissionMode | null = null;
  // 有效权限模式:plan 会话模式 > YOLO(=bypass)> 运行时覆盖 > settings 默认 > default。
  const getMode = (): PermissionMode =>
    session.mode === "plan"
      ? "plan"
      : yolo
        ? "bypassPermissions"
        : permModeOverride ?? loadedPerms.defaultMode ?? "default";

  const gate: ApprovalGate = new PermissionGate(
    getMode,
    getRules,
    (reqs) => (inkApprovalPrompt ?? readlinePrompt)(reqs), // Ink 态用模态,否则 readline
    (rule) => appendRule(localSettingsFile, rule, "allow"), // "always" 持久化
    (rule) => { sessionAllow.push(rule); }, // "session"/"always" 本会话生效
  );

  const session = new Session(systemPrompt, cfg.model);
  // settings/CLI/企业策略指定的初始模式:plan→会话只读规划;bypassPermissions→等价 YOLO。
  // default/acceptEdits 由 getMode 读 loadedPerms.defaultMode 处理,无需在此设置。
  if (loadedPerms.defaultMode === "plan") session.mode = "plan";
  else if (loadedPerms.defaultMode === "bypassPermissions") yolo = true;
  const ctx: ToolContext = {
    workspaceRoot,
    readFiles: new Set<string>(),
    ask: (q: string) => (inkAsk ? inkAsk(q) : ask(`\n${q}\n> `)),
    fetchImpl: fetch,
    today,
    verifyCommand: process.env.DAO_VERIFY_CMD?.trim() || undefined,
  };

  // 子代理的直接输出在 Ink 态需静默(否则 write 到 stdout 会冲掉 Ink 渲染;其最终结果仍作工具结果展示)。
  let subagentWrite: (s: string) => void = write;
  ctx.agentTypes = agentDefs.map((d) => ({ name: d.name, description: d.description }));
  ctx.skills = skills;

  // 生命周期钩子(.dao/hooks.json + 用户级):工具前/后、用户提交、会话起止。
  const hooks = await loadHooks([
    path.join(os.homedir(), ".dao", "hooks.json"),
    path.join(workspaceRoot, ".dao", "hooks.json"),
  ]);
  ctx.preToolHook = async (toolName, argsJson) => {
    const r = await runHooks(hooks, "PreToolUse", { cwd: workspaceRoot, toolName, payload: { tool: toolName, args: argsJson } });
    return { block: r.block, reason: r.reason };
  };
  ctx.postToolHook = async (toolName, argsJson, result) => {
    await runHooks(hooks, "PostToolUse", { cwd: workspaceRoot, toolName, payload: { tool: toolName, args: argsJson, result } });
  };
  await runHooks(hooks, "SessionStart", { cwd: workspaceRoot }); // 会话开始钩子
  ctx.createWorktree = (id: string) => createWorktree(workspaceRoot, id);
  ctx.sendToTask = (id: string, message: string) => taskManager.send(id, message);
  ctx.runSubagent = (task: string, signal?: AbortSignal, agentType?: string, wsRoot?: string, drainPending?: () => string[]) => {
    const def = agentType ? agentDefs.find((d) => d.name === agentType) : undefined;
    const sp = def ? `${systemPrompt}\n\n# 你的专用角色(${def.name})\n${def.prompt}` : systemPrompt;
    const reg = def?.tools ? registry.subset(new Set(def.tools)) : registry;
    const subCtx = wsRoot ? { ...ctx, workspaceRoot: wsRoot } : ctx; // worktree 隔离:覆盖工作区根
    return runSubagent({
      task,
      systemPrompt: sp,
      model: def?.model ?? session.model,
      mode: session.mode,
      config: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey },
      registry: reg,
      ctx: subCtx,
      gate,
      streamChat,
      executeToolCalls,
      write: subagentWrite,
      runTurn,
      signal,
      drainPending,
      writeTranscript: (messages) => {
        try {
          const dir = path.join((wsRoot ?? workspaceRoot), ".dao", "subagents");
          mkdirSync(dir, { recursive: true });
          const name = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jsonl`;
          writeFileSync(path.join(dir, name), messages.map((m) => JSON.stringify(m)).join("\n"));
        } catch { /* 观测落盘失败不影响 */ }
      },
    });
  };

  // 后台任务管理器:异步子代理 + 通知队列(主循环不阻塞)。
  const taskManager = createTaskManager();
  ctx.runBackgroundAgent = (task: string, agentType?: string) =>
    taskManager.launch(`${agentType ? `[${agentType}] ` : ""}${task.slice(0, 50)}`, (signal, id) =>
      ctx.runSubagent!(task, signal, agentType, undefined, () => taskManager.drainPending(id)),
    );
  ctx.adoptBackground = (description: string, promise: Promise<string>) => taskManager.adopt(description, promise);

  // 申请访问工作区外路径(读类工具):一次授权后本会话不再追问;选"本仓库后续都用"则持久化。
  let externalReadGranted = alwaysApproved.has("external-read");
  let externalWriteGranted = alwaysApproved.has("external-write");
  // CC additionalDirectories:settings 里预先授权的工作区外目录,直接放行不弹窗。
  const extraDirs = loadedPerms.additionalDirectories.map((d) => path.resolve(workspaceRoot, d));
  const underExtra = (abs: string) => extraDirs.some((d) => abs === d || abs.startsWith(d.endsWith("/") ? d : d + "/"));
  ctx.approveExternalRead = async (abs: string): Promise<boolean> => {
    if (yolo || externalReadGranted || underExtra(abs)) return true;
    if (!inkApprovalPrompt) return false; // 非交互(管道/eval)默认拒绝区外访问
    const decisions = await inkApprovalPrompt([
      { id: "ext", toolName: "读取(工作区外)", capability: "read", summary: `访问工作区外路径:${abs}` },
    ]);
    const d = decisions.get("ext") ?? "deny";
    if (d === "deny") return false;
    if (d === "always") {
      externalReadGranted = true;
      await appendAlwaysApproved(approvalsFile, "external-read");
    } else if (d === "session") {
      externalReadGranted = true;
    }
    return true; // once 放行本次
  };
  // 工作区外【写】授权(对标外部读):yolo / 已授权 / --add-dir 目录直接放行,否则弹审批。
  ctx.approveExternalWrite = async (abs: string): Promise<boolean> => {
    if (yolo || externalWriteGranted || underExtra(abs)) return true;
    if (!inkApprovalPrompt) return false; // 非交互默认拒绝区外写
    const decisions = await inkApprovalPrompt([
      { id: "extw", toolName: "写入(工作区外)", capability: "write", summary: `写入工作区外路径:${abs}` },
    ]);
    const d = decisions.get("extw") ?? "deny";
    if (d === "deny") return false;
    if (d === "always") { externalWriteGranted = true; await appendAlwaysApproved(approvalsFile, "external-write"); }
    else if (d === "session") { externalWriteGranted = true; }
    return true;
  };

  const KEEP_RECENT_TURNS = 2;
  const CONTEXT_WINDOW = 1_000_000;

  // 压缩用:对一批旧消息生成结构化中文摘要(独立一次 streamChat,不带工具,不流式渲染)。
  // 对标 CC:先 <分析> 草稿过一遍,再 <摘要> 输出 9 个固定小节;不丢技术细节/决策/用户原话。
  const COMPACT_PROMPT = `你是对话压缩器。把目前为止的对话压缩成一份详尽的中文摘要,重点保留用户的明确请求和你已做的动作,确保技术细节、代码模式、架构决策不丢,以便不丢上下文地继续工作。

先在 <分析> 标签里按时间顺序逐段过一遍对话——每段识别:用户的明确请求与意图、你的处理方式、关键决策与技术概念、具体文件名/代码片段/函数签名/文件改动、遇到的错误及修复、尤其用户给的纠正性反馈;核对技术准确与完整。然后在 <摘要> 标签里输出下面 9 个固定小节:

1. 主要请求与意图:详尽列出用户所有明确请求与意图
2. 关键技术概念:讨论到的所有重要技术/框架/概念
3. 文件与代码片段:查看/修改/新建的具体文件与代码段,附"为何重要"和关键代码(尤其最近的)
4. 错误与修复:遇到的错误、如何修复、以及用户对此的反馈
5. 问题解决:已解决的问题与进行中的排查
6. 所有用户消息:逐条列出所有非工具结果的用户消息(理解反馈与意图变化的关键)
7. 待办任务:明确被要求做、尚未完成的事
8. 当前工作:紧接本次压缩前正在做什么,含文件名与代码片段
9. 下一步(可选):仅当与用户最近的明确请求直接一致时才列,并附最近对话的【原话引用】以防任务理解漂移

只输出 <分析> 和 <摘要> 两个块的纯文本,不要寒暄。`;
  const summarize = async (msgs: ChatMessage[]): Promise<string> => {
    const rendered = msgs
      .map((m) => {
        if (m.role === "assistant" && m.tool_calls) {
          const calls = m.tool_calls.map((t) => `${t.function.name}(${t.function.arguments})`).join(", ");
          return `[assistant 调用工具] ${calls}${m.content ? `\n${m.content}` : ""}`;
        }
        return `[${m.role}] ${typeof m.content === "string" ? m.content : ""}`;
      })
      .join("\n");
    const gen = streamChat({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: session.model,
      messages: [
        { role: "system", content: COMPACT_PROMPT },
        { role: "user", content: rendered },
      ],
      // 摘要不需要深推理:关思考更快更省,温度 0 让压缩结果可复现。
      extra: { thinking: { type: "disabled" }, temperature: 0 },
    });
    let out = "";
    let r = await gen.next();
    while (!r.done) {
      if (r.value.kind === "content") out += r.value.text;
      r = await gen.next();
    }
    out = out.trim() || (typeof r.value.content === "string" ? r.value.content : "");
    // 剥掉 <分析> 草稿,只留 <摘要>(没标签则用全文)。
    const m = out.match(/<摘要>([\s\S]*?)<\/摘要>/);
    return (m ? m[1]! : out).trim() || "(摘要为空)";
  };

  const runCompaction = async (): Promise<void> => {
    const before = session.messages.length;
    session.messages = await compactMessages(
      session.messages,
      { keepRecentTurns: KEEP_RECENT_TURNS, summarize },
      todoStore.get().length ? formatTodos(todoStore.get()) : undefined,
    );
    const after = session.messages.length;
    write(after < before ? `\n[已压缩对话:${before} → ${after} 条消息]\n` : `\n[对话较短,无需压缩]\n`);
  };

  const runOneTurn = async () => {
    await runTurn({
      session,
      config: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey },
      registry,
      ctx,
      gate,
      streamChat,
      executeToolCalls,
      write,
    });
    if (shouldCompact(session.messages, CONTEXT_WINDOW)) {
      write("\n[接近上限,自动压缩…]\n");
      await runCompaction();
    }
  };

  // Ink 态压缩:不向 stdout 写(会冲渲染),只压缩消息;提示由 App 通过 events/notice 给出。
  const inkCompact = async (): Promise<void> => {
    session.messages = await compactMessages(
      session.messages,
      { keepRecentTurns: KEEP_RECENT_TURNS, summarize },
      todoStore.get().length ? formatTodos(todoStore.get()) : undefined,
    );
  };

  // 会话结束蒸馏:独立一次 flash + 关思考(distill 内部已设)抽取原子事实/用户模型,
  // 去重后 upsert 到项目记忆。全程 try/catch,失败绝不阻塞退出。仅当有 ≥1 轮真实用户对话时触发。
  const distillOnExit = async (): Promise<void> => {
    const hasRealTurn = session.messages.some((m) => m.role === "user");
    if (!hasRealTurn) return;
    write("\n正在更新记忆(蒸馏本次对话,需几秒)…\n"); // 退出后蒸馏要时间,先告知用户别以为卡住
    try {
      const cands = await distill({
        streamChat,
        config: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey },
        model: "deepseek-v4-flash", // 蒸馏一律用便宜的 flash,与会话所选模型无关
        messages: session.messages,
        today,
      });
      // 灰区(字符相似度抓不住的改写式近重复)交 flash 裁判判是否合并。
      const adjudicate = makeFlashAdjudicator(streamChat, { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
      let n = 0;
      for (const cand of cands) {
        const existing = await loadAllMemories(projectMemoryDir, userMemoryDir, knowledgeMemoryDir);
        // 三层路由:procedural=跨项目可复用知识→知识库;user/feedback=关于用户本人与合作方式→用户级;
        // 其余(semantic 项目事实 / episodic 项目进展)→项目级。
        const dir =
          cand.type === "procedural" ? knowledgeMemoryDir
          : cand.type === "user" || cand.type === "feedback" ? userMemoryDir
          : projectMemoryDir;
        await upsertMemory(dir, cand, existing, adjudicate);
        n++;
      }
      write(n > 0 ? `✓ 已更新记忆:${n} 条\n` : `✓ 记忆无需更新\n`);
    } catch (e) {
      if (process.env.DAO_DEBUG_MEMORY) console.error("[distill] 蒸馏失败:", e);
      // 失败不阻塞退出。
    }
  };

  try {
    if (argvPrompt) {
      // 一次性调用(含 eval 每次跑)不蒸馏:蒸馏只属于真实的交互式工作会话,
      // 既省掉快速查询的 flash 开销,也自动把 eval 排除在外、测量更干净。
      session.addUser(argvPrompt);
      await runOneTurn();
      if (session.usage.promptTokens > 0) write(`\n${session.usageSummary()}\n`);
      return;
    }
    const caps = detectCapabilities(process.env, process.stdout.isTTY ?? false, process.stdout.columns);
    let gitBranch: string | undefined;
    try {
      const head = readFileSync(path.join(workspaceRoot, ".git", "HEAD"), "utf8");
      gitBranch = head.match(/ref: refs\/heads\/(.+)/)?.[1]?.trim();
    } catch {}
    const welcomeInfo = {
      model: cfg.model,
      thinking: process.env.DAO_REASONING_EFFORT || "max",
      cwd: workspaceRoot,
      version: VERSION,
      branch: gitBranch,
    };

    if (process.stdout.isTTY) {
      // 交互态:Ink REPL(inline)。常见路径下从未创建 readline(stdin 干净),Ink 的 useInput 直接接管;
      // 仅当首次运行做过 key 引导才存在 rl,此时关掉让出 stdin。
      subagentWrite = () => {}; // Ink 态静默子代理直接输出
      closeRl();
      // @文件补全的文件缓存:启动时遍历一次工作区(上限 5000,沿用 walkFiles 的忽略规则)。
      const fileCache: string[] = [];
      try {
        for await (const { rel } of walkFiles(workspaceRoot)) {
          fileCache.push(rel);
          if (fileCache.length >= 5000) break;
        }
      } catch {}
      // 长任务地基:会话日志/状态快照(崩溃恢复)+ 影子 git 检查点(回滚)。
      const sessionsDir = path.join(workspaceRoot, ".dao", "sessions");
      let resumeId: string | undefined;
      let initialItems: TranscriptItem[] = [];
      if (continueFlag) {
        const prev = findResumable(sessionsDir, workspaceRoot);
        if (prev) {
          session.messages = prev.messages;
          session.setModel(prev.model);
          session.mode = prev.mode;
          session.usage.promptTokens += prev.usage.promptTokens;
          session.usage.completionTokens += prev.usage.completionTokens;
          session.usage.cacheHitTokens += prev.usage.cacheHitTokens;
          session.usage.cacheMissTokens += prev.usage.cacheMissTokens;
          resumeId = prev.id; // 续写同一会话文件
          const recap = transcriptFromMessages(prev.messages);
          recap.unshift({ id: 0, kind: "notice", text: "[已恢复上次会话]" });
          initialItems = recap.map((it, i) => ({ ...it, id: i + 1 })); // 统一编号(welcome 占 0)
        }
      }
      const store = createSessionStore(sessionsDir, resumeId);
      const ckpt = createCheckpointer(workspaceRoot);
      const turnCheckpoints: (string | null)[] = []; // 第 k 项 = 第 k 条用户消息【之前】的影子 git 快照 sha,供 /rewind 联动回滚文件
      let sessionTitle: string | undefined; // /rename 设置
      if (longTask && !continueFlag) session.messages.push({ role: "system", content: LONG_TASK_DIRECTIVE });
      if (coordinator && !continueFlag) session.messages.push({ role: "system", content: COORDINATOR_DIRECTIVE });
      const persist = () =>
        store.saveState({
          cwd: workspaceRoot,
          model: session.model,
          mode: session.mode,
          title: sessionTitle,
          messages: session.messages,
          usage: { ...session.usage },
        });
      await runInkApp({
        welcome: { info: welcomeInfo, caps, bg, maxim: randomMaxim() },
        verbose,
        submit: async (text, { events, signal }) => {
          // UserPromptSubmit 钩子:可阻断本次提交、或把命令输出注入为上下文。
          const up = await runHooks(hooks, "UserPromptSubmit", { cwd: workspaceRoot, payload: { prompt: text } });
          if (up.block) { events.notice(`[提交被 hook 阻止] ${up.reason || ""}`); return; }
          turnCheckpoints.push(ckpt.snapshot(`回合前: ${text.slice(0, 60)}`)); // 回合前快照(供 /restore 与 /rewind code 回退)
          store.append({ t: "user", text });
          session.addUser(text);
          if (up.context) session.messages.push({ role: "system", content: `[hook 注入的上下文]\n${up.context}` });
          await runTurn({
            session,
            config: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey },
            registry,
            ctx,
            gate,
            streamChat,
            executeToolCalls,
            write: () => {},
            events: logEvents(events, store), // 渲染的同时写日志
            maxTurns: longTask || coordinator ? 500 : undefined, // 长任务/Coordinator 给更高轮数上限(默认 150)
            signal,
          });
          store.append({ t: "turn_end" });
          if (shouldCompact(session.messages, CONTEXT_WINDOW)) {
            const before = session.messages.length;
            events.notice("[接近上限,自动压缩…]");
            await inkCompact();
            store.append({ t: "compaction", before, after: session.messages.length });
          }
          persist(); // 回合末存档(崩溃可恢复)
        },
        runCommand: (line) => {
          const name = line.trim().slice(1).split(/\s+/)[0];
          if (name === "skills") {
            const rest = line.trim().split(/\s+/).slice(1);
            const sub = rest[0];
            if (sub === "off" || sub === "on") {
              const target = rest[1];
              if (target && coreBundled.some((s) => s.name === target)) return { handled: true, output: `${target} 是内置核心技能,固定加载、不可开关。` };
              if (!target || !diskSkills.some((s) => s.name === target)) return { handled: true, output: `未知技能:${target ?? "(空)"}(只能开关项目/用户技能)` };
              if (sub === "off") disabledSet.add(target); else disabledSet.delete(target);
              try { writeFileSync(disabledPath, JSON.stringify([...disabledSet])); } catch {}
              return { handled: true, output: `已${sub === "off" ? "禁用" : "启用"}技能 ${target}(重启 dao 生效)` };
            }
            if (diskSkills.length === 0) return { handled: true, output: "暂无项目/用户技能。项目放 .dao/skills/,用户放 ~/.dao/skills/,或 dao skill add 安装。" };
            const rows = diskSkills.map((s) => `${disabledSet.has(s.name) ? "○ off" : "● on "}  ${s.name}  ·  ${skillSource(s)}  ·  ~${skillTokens(s)} tok  ·  ${s.description.slice(0, 48)}`);
            return { handled: true, output: `技能(${diskSkills.length};on 的描述常驻上下文、模型按需加载正文。/skills off|on <名> 开关,重启生效)\n` + rows.join("\n") };
          }
          if (name === "context") {
            const used = estimateTokens(session.messages);
            const sys = estimateTokens(session.messages.slice(0, 1));
            const pct = Math.round((used / CONTEXT_WINDOW) * 100);
            return { handled: true, output: `上下文:~${used.toLocaleString()} / ${CONTEXT_WINDOW.toLocaleString()} tok(${pct}%)\n  系统+技能 ~${sys.toLocaleString()} · 对话 ~${(used - sys).toLocaleString()}\n  ${pct >= 85 ? "接近上限,下回合将自动压缩(也可 /compact)" : "余量充足"}` };
          }
          if (name === "tasks") {
            const r = taskManager.running();
            if (r.length === 0) return { handled: true, output: "无运行中的后台任务。" };
            return { handled: true, output: `后台任务(${r.length}):\n` + r.map((t) => `  ${t.id} · ${t.status} · ${t.description}`).join("\n") };
          }
          if (name === "mcp") {
            if (mcp.servers.length === 0) return { handled: true, output: "未配置 MCP 服务器。在 ~/.dao/mcp.json 或 <项目>/.dao/mcp.json 写 mcpServers 即可。" };
            return { handled: true, output: "MCP 服务器:\n" + mcp.servers.map((s) => `  ${s.ok ? "✓" : "✗"} ${s.name} · ${s.tools} 个工具${s.error ? ` · ${s.error}` : ""}`).join("\n") };
          }
          if (name === "diff") {
            try {
              const status = execSync("git status --short", { cwd: workspaceRoot, encoding: "utf8" }).trim();
              const stat = execSync("git diff --stat", { cwd: workspaceRoot, encoding: "utf8" }).trim();
              if (!status && !stat) return { handled: true, output: "无未提交变更。" };
              return { handled: true, output: (status ? `变更文件:\n${status}\n` : "") + (stat ? `\n${stat}` : "") };
            } catch (e) { return { handled: true, output: `git 失败(可能非 git 仓库):${(e as Error).message}` }; }
          }
          if (name === "doctor") {
            const checks: string[] = [];
            checks.push(cfg.apiKey ? "✓ API key 已配置" : "✗ 缺 API key(设 DEEPSEEK_API_KEY 或写 ~/.dao/config.json)");
            try { checks.push(`✓ dao 在 PATH:${execSync("command -v dao", { encoding: "utf8" }).trim()}`); }
            catch { checks.push("✗ dao 不在 PATH(把 ~/.local/bin 加进 PATH)"); }
            if (process.platform === "darwin") {
              try { execSync(`codesign -v "${process.execPath}" 2>&1`); checks.push("✓ 二进制签名有效"); }
              catch { checks.push("✗ 二进制签名无效 → 重装:npm run bundle:install"); }
            }
            checks.push(`· 工作区 ${workspaceRoot} · 模型 ${session.model} · ${mcp.servers.length} 个 MCP 服务器`);
            return { handled: true, output: "dao doctor:\n" + checks.map((c) => "  " + c).join("\n") };
          }
          if (name === "memory") {
            const tiers: [string, string][] = [["用户", userMemoryDir], ["知识", knowledgeMemoryDir], ["项目", projectMemoryDir]];
            const lines = tiers.map(([label, dir]) => {
              let files: string[] = [];
              try { files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md"); } catch { /* 目录不存在 */ }
              return `${label}(${dir}):${files.length ? files.join(", ") : "(空)"}`;
            });
            return { handled: true, output: "记忆三层:\n" + lines.map((l) => "  " + l).join("\n") + "\n(用 memory_write 增改;文件即上述目录里的 .md)" };
          }
          if (name === "permissions") {
            const r = getRules();
            const fmt = (label: string, arr: string[]) => `${label}:${arr.length ? arr.join(", ") : "(无)"}`;
            return { handled: true, output: `权限规则(模式 ${getMode()};deny>ask>allow):\n  ${fmt("allow", r.allow)}\n  ${fmt("ask", r.ask)}\n  ${fmt("deny", r.deny)}\n(改 .dao/settings.json 的 permissions)` };
          }
          if (name === "resume") {
            const id = line.trim().split(/\s+/)[1];
            let sids: string[] = [];
            try { sids = readdirSync(sessionsDir); } catch { /* 无 */ }
            if (sids.length === 0) return { handled: true, output: "本工作区无历史会话。" };
            if (!id) return { handled: true, output: `历史会话(${sids.length}):\n` + sids.slice(-15).reverse().map((s) => { const st = loadState(sessionsDir, s); return `  ${s}${st?.title ? ` — ${st.title}` : ""}`; }).join("\n") + "\n用 /resume <会话id> 载入其上下文。" };
            const st = loadState(sessionsDir, id);
            if (!st) return { handled: true, output: `未找到会话:${id}(/resume 看列表)` };
            session.messages = st.messages; // 整盘载入上下文(继续写入当前会话文件,不动原文件)
            session.setModel(st.model);
            return { handled: true, output: `已载入会话 ${id} 的上下文(${st.messages.length} 条消息;继续写入当前会话)`, clearTranscript: true };
          }
          if (name === "branch") {
            const label = line.trim().split(/\s+/).slice(1).join(" ");
            const b = createSessionStore(sessionsDir); // 新会话 id
            b.saveState({ cwd: workspaceRoot, model: session.model, mode: session.mode, title: label || undefined, messages: session.messages, usage: { ...session.usage } });
            return { handled: true, output: `已把当前会话快照分支为 ${b.id}${label ? `(${label})` : ""}。\n切到该分支上下文:/resume ${b.id}(当前会话不受影响)` };
          }
          if (name === "rename") {
            const t = line.trim().split(/\s+/).slice(1).join(" ").trim();
            if (!t) return { handled: true, output: `用法:/rename <标题>${sessionTitle ? `(当前:${sessionTitle})` : ""}` };
            sessionTitle = t;
            persist();
            return { handled: true, output: `会话已命名:${t}` };
          }
          if (name === "rewind") {
            const arg = line.trim().split(/\s+/)[1];
            const userIdx = session.messages.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i >= 0);
            if (userIdx.length === 0) return { handled: true, output: "本会话还没有可回退的节点。" };
            if (!arg) {
              const list = userIdx.map((idx, n) => {
                const c = session.messages[idx]!.content;
                return `  ${n + 1}. ${(typeof c === "string" ? c : "").replace(/\n/g, " ").slice(0, 60)}`;
              });
              return { handled: true, output: `回退节点(到第几条用户消息【之前】):\n${list.join("\n")}\n用 /rewind <序号> 截断对话;/rewind <序号> code 同时回滚文件(影子 git,不动你的真实提交)` };
            }
            const rest = line.trim().split(/\s+/).slice(1);
            const n = Number(rest[0]);
            const withCode = rest.includes("code");
            if (!Number.isInteger(n) || n < 1 || n > userIdx.length) return { handled: true, output: `序号越界(1–${userIdx.length})` };
            session.messages = session.messages.slice(0, userIdx[n - 1]); // 丢弃该用户消息及其后
            let codeMsg = "";
            if (withCode) {
              const sha = turnCheckpoints[n - 1];
              if (!ckpt.enabled) codeMsg = " 文件未回滚(无影子 git)。";
              else if (!sha) codeMsg = " 文件未回滚(该节点无快照)。";
              else codeMsg = ckpt.restore(sha) ? " 文件已回滚到该节点(真实 git 提交未动)。" : " 文件回滚失败。";
            }
            return { handled: true, output: `已回退到第 ${n} 条用户消息之前(现 ${session.messages.length} 条消息)。${codeMsg || "(对话回退;加 code 可同时回滚文件)"}`, clearTranscript: true };
          }
          if (name === "export") {
            const ts = new Date().toISOString().replace(/[:.]/g, "-");
            const dir = path.join(workspaceRoot, ".dao", "exports");
            mkdirSync(dir, { recursive: true });
            const file = path.join(dir, `session-${ts}.md`);
            const md = session.messages
              .map((m) => `## ${m.role}\n\n${typeof m.content === "string" ? m.content : JSON.stringify(m.content, null, 2)}`)
              .join("\n\n---\n\n");
            writeFileSync(file, md);
            return { handled: true, output: `已导出对话 → ${file}(${session.messages.length} 条消息)` };
          }
          if (name === "config") {
            return { handled: true, output: `配置:\n  模型 ${cfg.model} · baseUrl ${cfg.baseUrl} · 权限模式 ${getMode()}\n  设置文件:~/.dao/settings.json(用户)· <项目>/.dao/settings.json · .dao/settings.local.json\n(编辑这些文件改配置;权限规则见 /permissions,MCP 见 ~/.dao/mcp.json)` };
          }
          if (name === "effort") {
            const valid = ["low", "medium", "high", "max"];
            const arg = line.trim().split(/\s+/)[1];
            const cur = process.env.DAO_REASONING_EFFORT || "max";
            if (!arg) return { handled: true, output: `当前思考强度:${cur}。用法:/effort <${valid.join("|")}>` };
            if (!valid.includes(arg)) return { handled: true, output: `无效:${arg}(可选 ${valid.join("/")})` };
            process.env.DAO_REASONING_EFFORT = arg;
            return { handled: true, output: `思考强度已设为 ${arg}(下一回合生效)` };
          }
          if (name === "status") {
            const pct = Math.round((estimateTokens(session.messages) / CONTEXT_WINDOW) * 100);
            const flags = [yolo ? "YOLO" : "", longTask ? "长任务" : "", coordinator ? "Coordinator" : ""].filter(Boolean).join("/") || "—";
            return { handled: true, output: `状态:模型 ${session.model} · 模式 ${getMode()} · 开关 ${flags} · 上下文 ${pct}% · 思考 ${process.env.DAO_REASONING_EFFORT || "max"}\n${session.usageSummary()}` };
          }
          if (name === "plugin") {
            if (installedPlugins.length === 0) return { handled: true, output: "未装插件。装:dao plugin add <git-url|路径>(插件根需 plugin.json + skills/)。" };
            const lines = installedPlugins.map((p) => {
              const n = diskSkills.filter((s) => s.dir.startsWith(p.dir)).length;
              return `  ${p.name} · ${n} 技能 · ${p.description}`;
            });
            return { handled: true, output: `已装插件(${installedPlugins.length}):\n` + lines.join("\n") + "\n(增删:dao plugin add/remove,重启生效)" };
          }
          if (name === "yolo") {
            yolo = !yolo;
            return { handled: true, output: yolo ? "⚡ YOLO 已开启:自动批准所有写/执行操作(deny 规则仍拦截)" : "YOLO 已关闭:恢复审批门" };
          }
          if (name === "mode") {
            const arg = line.trim().split(/\s+/)[1];
            if (!arg) {
              return { handled: true, output: `当前权限模式:${getMode()}。用法:/mode <default|acceptEdits|plan|bypassPermissions>` };
            }
            if (arg === "plan") { session.mode = "plan"; permModeOverride = null; yolo = false; return { handled: true, output: "📋 已切到 plan(只读规划,拦写/执行)" }; }
            if (arg === "bypassPermissions") { yolo = true; if (session.mode === "plan") session.mode = "normal"; return { handled: true, output: "⚡ bypassPermissions:跳过所有审批(deny 规则仍拦截)" }; }
            if (arg === "default" || arg === "acceptEdits") {
              yolo = false;
              if (session.mode === "plan") session.mode = "normal";
              permModeOverride = arg as PermissionMode;
              return { handled: true, output: arg === "acceptEdits" ? "✎ acceptEdits:自动批准文件编辑,其余照常审批" : "权限模式已设为 default(按需审批)" };
            }
            return { handled: true, output: `未知模式:${arg}(可选 default/acceptEdits/plan/bypassPermissions)` };
          }
          if (name === "task") {
            longTask = !longTask;
            if (longTask) {
              yolo = true;
              session.messages.push({ role: "system", content: LONG_TASK_DIRECTIVE });
              return { handled: true, output: "🪢 长任务自主模式已开启:自动批准 + 自主连续推进 + 更高轮数;直接说出要做的长任务即可。" };
            }
            return { handled: true, output: "长任务模式已关闭(YOLO 仍按当前状态,可用 /yolo 切)。" };
          }
          if (name === "coordinator") {
            coordinator = !coordinator;
            if (coordinator) {
              yolo = true;
              session.messages.push({ role: "system", content: COORDINATOR_DIRECTIVE });
              return { handled: true, output: "🧭 Coordinator 模式已开启:研究(并行)→综合→实现→验证 多 agent 编排;直接说出要做的较大任务即可。" };
            }
            return { handled: true, output: "Coordinator 模式已关闭。" };
          }
          if (name === "dod") {
            const arg = line.trim().slice(1).split(/\s+/).slice(1).join(" ").trim();
            if (!arg) {
              return { handled: true, output: ctx.verifyCommand ? `当前验收命令:${ctx.verifyCommand}(/dod off 清除)` : "未设验收命令。用法:/dod <命令>(如 /dod npm test);设了则 verify_done 跑它判完成" };
            }
            ctx.verifyCommand = arg === "off" ? undefined : arg;
            return { handled: true, output: ctx.verifyCommand ? `验收命令已设:${ctx.verifyCommand}` : "已清除验收命令(改为模型自判)" };
          }
          // 内置 prompt 命令(simplify/remember/debug/skillify):展开成 prompt 跑一回合。
          if (name) {
            const args = line.trim().slice(1).split(/\s+/).slice(1).join(" ");
            const b = runBuiltinCommand(name, args);
            if (b) return { handled: true, ...b };
          }
          // 自定义命令:/name [args] → 展开成 prompt 跑一个回合。
          if (name && customCommands.has(name)) {
            const args = line.trim().slice(1).split(/\s+/).slice(1).join(" ");
            return { handled: true, prompt: expandCommand(customCommands.get(name)!.body, args) };
          }
          if (name === "restore") {
            if (!ckpt.enabled) return { handled: true, output: "检查点不可用(无 git)" };
            const snaps = ckpt.list();
            const target = snaps[1] ?? snaps[0]; // 回退到上一个回合前的快照
            if (!target) return { handled: true, output: "暂无可回退的检查点" };
            const ok = ckpt.restore(target.ref);
            return { handled: true, output: ok ? `已回退工作区到检查点:${target.label}` : "回退失败" };
          }
          return dispatchCommand(line, session);
        },
        compact: inkCompact,
        getStatus: () => ({
          model: session.model,
          mode: session.mode,
          permMode: getMode(),
          promptTokens: session.usage.promptTokens,
          completionTokens: session.usage.completionTokens,
          cacheHitRatio: session.cacheHitRatio(),
          yolo,
          longTask,
          coordinator,
          branch: gitBranch,
          contextPct: (estimateTokens(session.messages) / CONTEXT_WINDOW) * 100,
        }),
        cycleMode: () => {
          const order: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];
          const next = order[(order.indexOf(getMode()) + 1) % order.length]!;
          yolo = next === "bypassPermissions";
          session.mode = next === "plan" ? "plan" : "normal";
          permModeOverride = next === "plan" || next === "bypassPermissions" ? null : next;
          return next;
        },
        register: ({ approvalPrompt, askUser }) => {
          inkApprovalPrompt = approvalPrompt;
          inkAsk = askUser;
        },
        completeFiles: (prefix) =>
          (prefix ? fileCache.filter((f) => f.includes(prefix)) : fileCache).slice(0, 8),
        initialItems,
        drainNotifications: () => taskManager.drainNotifications(),
        subscribeTasks: (cb) => taskManager.onChange(cb),
        runningTasks: () => taskManager.running().length,
      });
      taskManager.cancelAll(); // 退出时中止所有后台任务
      await runHooks(hooks, "SessionEnd", { cwd: workspaceRoot }); // 会话结束钩子
      await mcp.close(); // 关闭 MCP 连接
      store.markDone(); // 干净退出 → 标记会话完成(不再被 findResumable 当崩溃会话)
    } else {
      // 非交互(管道/CI/eval):纯文本 banner + readline REPL,行为不变。
      write(buildWelcome(welcomeInfo, caps, undefined, bg) + "\n");
      const readLine = async (): Promise<string | null> => {
        write("\n> ");
        return nextLine();
      };
      await runRepl({ session, readLine, runTurn: runOneTurn, write, compact: runCompaction });
      await mcp.close();
    }
    if (session.usage.promptTokens > 0) write(`\n${session.usageSummary()}\n`);
    await distillOnExit();
  } finally {
    closeRl();
  }
}

main().catch((err) => {
  console.error("\n" + (err as Error).message);
  process.exit(1);
});
