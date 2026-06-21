#!/usr/bin/env node
import { createInterface, type Interface } from "node:readline/promises";
import { readFileSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { loadDotenv } from "./config/env_file.js";
import { loadProfiles, saveProfiles, setActive, removeProfile } from "./config/profiles_store.js";
import { DEFAULTS } from "./config/profiles.js";
import { resolveCredential, persistKey } from "./config/credential.js";
import { validateCredential } from "./config/validate_key.js";
import { runKeyWizard } from "./config/auth_wizard.js";
import { runtimeKeychain, noopKeychain, keychainAvailable, keychainDelete } from "./config/keychain.js";
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
import { skillInstallTool } from "./tools/skill_install.js";
import { loadPlugins, installPlugin, removePlugin, pluginsRoot, pluginComponentDirs } from "./plugins.js";
import { loadProjectInstructions } from "./project_doc.js";
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
import { memoryReadTool } from "./tools/memory_read.js";
import { verifyDoneTool } from "./tools/verify.js";
import { runSubagent } from "./agent/subagent.js";
import { createTaskManager } from "./agent/tasks.js";
import { loadAgentDefs } from "./agent/agent_defs.js";
import { BUNDLED_AGENTS } from "./agent/bundled_agents.js";
import { createWorktree } from "./agent/worktree.js";
import { runDiagnosticsCmd, detectDiagnosticsCmd } from "./tools/diagnostics.js";
import { shouldTrustProject, addTrusted } from "./config/trust.js";
import { maybeCleanup } from "./agent/cleanup.js";
import { maybeCheckUpdate } from "./config/update_check.js";
import { notify } from "./tui/notifier.js";
import { acquireWakeLock } from "./tui/wakelock.js";
import { loadCustomCommands, expandCommand } from "./commands/custom.js";
import { loadSkills, findUserInvocableSkill } from "./skills/skills.js";
import { BUNDLED_SKILLS, toggleBundled } from "./skills/bundled.js";
import { loadUsage, saveUsage, recordUsage } from "./skills/usage.js";
import { makeSkillAdapter } from "./skills/convert.js";
import { skillTool } from "./tools/skill.js";
import { taskSendTool } from "./tools/task_send.js";
import { messageParentTool } from "./tools/message_parent.js";
import { loadHooks, runHooks } from "./hooks/hooks.js";
import { loadMcpConfig, connectMcpServers, type ElicitHandler } from "./mcp/mcp.js";
import { processManager } from "./tools/process_manager.js";
import { agentTool } from "./tools/agent.js";
import { loadAllMemories, upsertMemory, migrateLegacy, routeScope } from "./memory/store.js";
import { gatherAudit, formatAudit } from "./memory/audit.js";
import { buildClassifierMessages } from "./permissions/classifier.js";
import { validateMemory, type Verdict } from "./memory/validate.js";
import { buildMemorySection, selectFullText, selectIndexNames, buildIndexSection } from "./memory/inject.js";
import { shouldCaptureMemory } from "./memory/capture_policy.js";
import { apiToolsForMode } from "./tools/tools_for_mode.js";
import { CHALLENGER_PROMPT, REFOCUSER_PROMPT } from "./agent/reflect_prompts.js";
import { createReplyChallenge } from "./agent/reply_challenge.js";
import { gcMemories } from "./memory/gc.js";
import { distill } from "./memory/distill.js";
import { makeFlashAdjudicator } from "./memory/adjudicate.js";
import type { ApprovalGate } from "./approval/types.js";
import { makeApprovalPrompt } from "./approval/stdin_prompt.js";
import { loadAlwaysApproved, appendAlwaysApproved } from "./approval/store.js";
import { PermissionGate } from "./permissions/gate.js";
import { loadPermissions, mergePermissions, appendRule, enterpriseSettingsPath, extractCliPermissions, type PermissionMode } from "./permissions/settings.js";
import { buildSystemPrompt, LONG_TASK_DIRECTIVE } from "./prompt/system_prompt.js";
import { Session } from "./session/session.js";
import { createSessionStore, logEvents, findResumable, loadState, listSessions } from "./session/log.js";
import { createCacheAuditSink, type CacheAuditSink, formatCacheReport } from "./session/cache_audit.js";
import { auditEnabled } from "./session/audit_switch.js";
import { createMemoryAuditSink, type MemoryAuditSink, summarizeMemoryTrace, formatMemoryReport } from "./memory/memory_audit.js";
import { createToolAuditSink, type ToolAuditSink, summarizeToolTrace, formatToolReport } from "./tools/tool_audit.js";
import { createPermAuditSink, type PermAuditSink, summarizePermTrace, formatPermReport } from "./permissions/perm_audit.js";
import { createSkillAuditSink, type SkillAuditSink, readAllSkillTraces, summarizeSkillTrace, formatSkillReport } from "./skills/skill_audit.js";
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
import { globToRegExp } from "./tools/glob.js";
import type { ApprovalPrompt } from "./approval/types.js";
import { VERSION } from "./version.js";
import { compactMessages, estimateTokens } from "./agent/compact.js";
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
  // 操作员命令:dao trust —— 信任当前目录,允许加载其项目级 .dao/settings.json 与 hooks.json。不连 API。
  if (rawArgs[0] === "trust") {
    const cwd = process.cwd();
    await addTrusted(cwd);
    process.stdout.write(`✓ 已信任 ${cwd}(下次启动将加载其 .dao/settings.json 与 hooks.json)\n`);
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
  const taskFlag = rawArgs.includes("--goal") || rawArgs.includes("--task") || rawArgs.includes("--coordinator"); // --task/--coordinator 为旧别名,均进长任务自主模式(已并入)
  const verbose = rawArgs.includes("--verbose") || rawArgs.includes("--debug");
  const flags = new Set(["--yolo", "--continue", "-c", "--goal", "--task", "--coordinator", "--verbose", "--debug"]);
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

  // ---- 解析当前生效凭证:env 覆盖 > 激活 profile(钥匙串/文件)> 首次运行引导 ----
  // profile = { provider + 凭证 + baseUrl + 默认 model };多 key 切换 = 切 profile,多 provider 同构。
  const dotenv = await loadDotenv(path.join(workspaceRoot, ".env"));
  const effectiveEnv = { ...dotenv, ...process.env }; // 环境变量优先,.env 填空缺
  const kc = keychainAvailable() ? runtimeKeychain : noopKeychain; // keychain 优先,文件兜底
  let profilesCfg = await loadProfiles(keyFile); // 自动迁移旧版 { apiKey }
  let resolved = await resolveCredential(profilesCfg, effectiveEnv, kc);
  let firstRun = false; // 跑过 key 引导 → 信任步骤呈现为同一 onboarding 的下一步

  if (!resolved) {
    if (process.stdin.isTTY) {
      // 真终端:引导粘贴 → 落盘前校验 → 钥匙串/文件存储 → 标记 onboarding 完成
      write(`\n欢迎使用 DAO CODE。先完成两步设置。\n\n[1/2] DeepSeek API key\n${KEY_HELP}\n`);
      const wiz = await runKeyWizard({
        cfg: profilesCfg,
        name: "default",
        meta: { provider: "deepseek", ...DEFAULTS.deepseek },
        ask,
        write,
        validate: (c) => validateCredential(c),
        kc,
        preferKeychain: keychainAvailable(),
      });
      if (!wiz) {
        write("未配置 key,已退出。\n");
        closeRl();
        process.exit(1);
      }
      profilesCfg = { ...wiz.cfg, onboardingComplete: true };
      await saveProfiles(keyFile, profilesCfg);
      resolved = wiz.resolved;
      firstRun = true;
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

  // cfg 形态保持 { apiKey, baseUrl, model } 不变(下游 20+ 处沿用);keySource 仅用于呈现来源。
  let keySource = resolved.source;
  const cfg = { apiKey: resolved.key, baseUrl: resolved.baseUrl, model: resolved.model };
  // 明确呈现来源,杜绝"env 里有 key 静默覆盖、被偷偷计费"的惊吓(对标 gemini-cli $150 trap)。
  if (keySource.startsWith("env:")) write(`※ 正在使用来自环境变量 ${keySource.slice(4)} 的 key(覆盖了已存 profile)。\n`);

  // ---- 目录信任(P2-37):紧接 key 之后,作为首次 onboarding 的第二步(对标 CC 单一连贯流程)----
  // 未信任目录【不加载】其项目级 settings/hooks,防恶意仓库自动执行。必须在加载任何项目级配置之前决定。
  // 对标 CC 信任对话:交互终端进入未信任文件夹时直接问,y→信任整个文件夹并当场加载(无需重启);
  // 否则继续不信任(只用用户级)。headless(-p 一次性)与非 TTY 不弹问,默认不信任(自动化不卡交互、安全默认)。
  let trustProject = await shouldTrustProject(workspaceRoot);
  if (!trustProject) {
    if (process.stdin.isTTY && !argvPrompt) {
      const a = (await ask(
        `${firstRun ? "\n[2/2] 目录信任\n" : "\n"}⚠ 此文件夹尚未信任:\n  ${workspaceRoot}\ndao 会加载并可能执行它的项目配置(.dao/settings.json 与 hooks.json)。\n是否信任此文件夹?[y/N] `,
      )).trim().toLowerCase();
      if (a === "y" || a === "yes") {
        await addTrusted(workspaceRoot);
        trustProject = true;
        write(`✓ 已信任此文件夹,加载其项目配置。\n`);
      } else {
        write(`已继续(未信任):项目级 settings/hooks 不加载。之后可运行 \`dao trust\` 信任。\n`);
      }
    } else {
      process.stderr.write(`⚠ 未信任此目录的项目配置(.dao/settings.json 与 hooks.json 未加载)。确认安全后运行 \`dao trust\` 再启动以加载。\n`);
    }
  }
  if (firstRun) write(`\n✓ 设置完成,开始吧。\n`);

  // ---- 账户(profile)操作:供 /account 选择器与 /login /logout 共用(单一实现,UI 只是壳)----
  const listAccounts = () =>
    Object.keys(profilesCfg.profiles).map((n) => {
      const p = profilesCfg.profiles[n]!;
      return { name: n, active: n === profilesCfg.activeProfile, detail: `${p.provider}/${p.model} · ${p.keyRef ? "钥匙串" : "文件"}` };
    });
  // 切换:钥匙串读取是异步的,后台解析并更新 cfg(下一回合 streamChat 读 cfg.apiKey)。
  const switchAccount = (name: string): boolean => {
    if (!profilesCfg.profiles[name]) return false;
    profilesCfg = setActive(profilesCfg, name);
    saveProfiles(keyFile, profilesCfg).catch(() => {});
    resolveCredential(profilesCfg, {}, kc).then((r) => {
      if (r) { cfg.apiKey = r.key; cfg.baseUrl = r.baseUrl; cfg.model = r.model; keySource = r.source; }
    }).catch(() => {});
    return true;
  };
  const removeAccount = (name: string): void => {
    const ref = profilesCfg.profiles[name]?.keyRef;
    if (ref?.startsWith("keychain:")) keychainDelete(ref.slice("keychain:".length)).catch(() => {});
    profilesCfg = removeProfile(profilesCfg, name);
    saveProfiles(keyFile, profilesCfg).catch(() => {});
  };
  // 起名:未指定时取 default / account-2 / account-3… 第一个空位。
  const nextAccountName = (): string => {
    if (!profilesCfg.profiles.default) return "default";
    for (let i = 2; ; i++) if (!profilesCfg.profiles[`account-${i}`]) return `account-${i}`;
  };
  // 添加:校验 → 持久化(钥匙串优先)→ 激活并即时生效。失败返回原因,不落盘。
  const addAccount = async (key: string, name?: string): Promise<{ ok: boolean; name?: string; reason?: string }> => {
    const targetName = name?.trim() || nextAccountName();
    const cur = profilesCfg.profiles[targetName];
    const meta = cur
      ? { provider: cur.provider, baseUrl: cur.baseUrl, model: cur.model }
      : { provider: "deepseek" as const, ...DEFAULTS.deepseek };
    const v = await validateCredential({ baseUrl: meta.baseUrl, key });
    if (!v.ok) return { ok: false, reason: v.reason };
    const { cfg: nc } = await persistKey(profilesCfg, targetName, meta, key, kc, { preferKeychain: keychainAvailable() });
    profilesCfg = { ...nc, onboardingComplete: true };
    await saveProfiles(keyFile, profilesCfg);
    cfg.apiKey = key; keySource = `profile:${targetName}`;
    return { ok: true, name: targetName };
  };

  const registry = new ToolRegistry();
  for (const t of [
    readFileTool, listDirTool, writeFileTool, editFileTool, multiEditTool, notebookEditTool,
    execShellTool, execShellPollTool, execShellKillTool,
    grepFilesTool, fileSearchTool, askUserTool, fetchUrlTool, webSearchTool, todoWriteTool, memoryWriteTool, memoryReadTool, verifyDoneTool, skillTool, skillInstallTool, taskSendTool, messageParentTool, agentTool, scheduleTool,
  ]) {
    registry.register(t);
  }

  // MCP:连配置的 server,把其工具/资源/提示注册进来(名字 mcp__server__*)。失败的 server 不影响其余/启动。
  const mcpConfig = await loadMcpConfig([
    path.join(os.homedir(), ".dao", "mcp.json"),
    path.join(workspaceRoot, ".dao", "mcp.json"),
  ]);
  // elicitation 处理器:连接发生在 UI 就绪前,故经可变引用延迟绑定(下方 inkAsk 声明后赋值)。未绑定则婉拒。
  let mcpElicit: ElicitHandler | null = null;
  const mcp = await connectMcpServers(mcpConfig, {
    onElicit: (m, s) => (mcpElicit ? mcpElicit(m, s) : Promise.resolve({ action: "decline" as const })),
  });
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
  // 两层读取:高价值整句全文常驻 + 长尾只给 slug 名索引(memory_read 按需取整句)。
  // 都在会话开始算定、整会话固定(进会话固定区),不刷新、不破前缀缓存。
  const injectedMems = selectFullText(validated, today);
  const indexNames = selectIndexNames(validated, today, injectedMems);
  const memoryText = buildMemorySection(injectedMems) + buildIndexSection(indexNames);
  const recallStale = validated.filter((v) => v.verdict === "stale").length;
  const recallChanged = validated.filter((v) => v.verdict === "changed").length;
  const recallTypes: Record<string, number> = {};
  for (const it of injectedMems) recallTypes[it.mem.type] = (recallTypes[it.mem.type] ?? 0) + 1;

  // B-5 插件多组件:插件除 skills 外还可带 commands/agents/hooks;先加载插件、聚合其组件目录。
  const installedPlugins = await loadPlugins();
  const pluginComp = pluginComponentDirs(installedPlugins);
  // 自定义子代理类型(.dao/agents/*.md + 插件 agents/):专属 prompt/工具白名单/模型。
  const diskAgentDefs = await loadAgentDefs(
    path.join(workspaceRoot, ".dao", "agents"),
    path.join(os.homedir(), ".dao", "agents"),
    pluginComp.agentDirs,
  );
  // 并入内置子代理(explore/verify);同名磁盘定义优先(可覆盖)。
  const diskAgentNames = new Set(diskAgentDefs.map((d) => d.name));
  const agentDefs = [...diskAgentDefs, ...BUNDLED_AGENTS.filter((a) => !diskAgentNames.has(a.name))];
  // 自定义 slash 命令(.dao/commands/*.md + 插件 commands/):/name 展开成 prompt。
  const customCommands = await loadCustomCommands(
    path.join(workspaceRoot, ".dao", "commands"),
    path.join(os.homedir(), ".dao", "commands"),
    pluginComp.commandDirs,
  );
  const agentTypesSection =
    agentDefs.length > 0
      ? `\n\n# 可用子代理类型(派 agent 时用 agent_type 指定,各有专属角色与工具)\n` +
        agentDefs.map((d) => `- ${d.name}:${d.description}`).join("\n")
      : "";
  // 开箱即用 skill(.dao/skills/ + 已装插件的 skills/):启动只列 name+description,模型用 skill 工具按需取正文。
  // 插件技能打【命名空间】(=插件名):用于 plugin:slug 调用与防撞;本地/项目/内置不加前缀。
  const pluginSkills = (await Promise.all(installedPlugins.map(async (p) => (await loadSkills(p.skillsDir)).map((s) => ({ ...s, namespace: p.name }))))).flat();
  const diskSkills = [
    ...(await loadSkills(path.join(os.homedir(), ".dao", "skills"), path.join(workspaceRoot, ".dao", "skills"))),
    ...pluginSkills,
  ];
  const diskNames = new Set(diskSkills.map((s) => s.name));
  // skill 去重(对齐 CC):物理文件去 realpath(loadSkills 内)、同名按优先级覆盖、插件加命名空间防撞、条件技能按 paths 收窄。
  //   仍无法自动消的是【不同名的语义重复】(dao debugging vs superpowers Systematic Debugging)——CC 也不自动去,靠策展:
  //   保留 dao 原生(更贴),冗余的让用户 /skills 关。来源已在 /skills 列表标 [内置/用户/插件]。
  // 禁用集(~/.dao/skills-disabled.json):被禁用的技能(内置或磁盘)都不注入上下文(省 token),/skills 可开关。
  const disabledPath = path.join(os.homedir(), ".dao", "skills-disabled.json");
  const disabledSet = new Set<string>((() => { try { return JSON.parse(readFileSync(disabledPath, "utf8")); } catch { return []; } })());
  // 内置技能:默认开、描述常驻上下文(可自动触发)。同名磁盘/插件技能覆盖之;也可在 /skills 关(对标 CC disableBundledSkills)。
  const coreBundled = BUNDLED_SKILLS
    .filter((b) => b.core && !diskNames.has(b.name) && !disabledSet.has(b.name))
    .map((b) => ({ name: b.name, description: b.description, body: b.body, dir: "", slug: b.name, ...(b.modelInvokable === false ? { modelInvokable: false } : {}), ...(b.userInvocable === false ? { userInvocable: false } : {}) } as import("./skills/skills.js").Skill));
  const pluginsDir = pluginsRoot();
  const skillSource = (s: { dir: string }) => (s.dir.startsWith(pluginsDir) ? "插件" : s.dir.startsWith(workspaceRoot) ? "项目" : "用户");
  const skillTokens = (s: { name: string; description: string }) => Math.max(1, Math.round((s.name.length + s.description.length) / 2));
  const enabledDisk = diskSkills.filter((s) => !disabledSet.has(s.name));
  // /skills 选择器后端:列出(内置+磁盘)、单开关、批量(内置/第三方/全部)。写禁用集,重启生效。
  const persistDisabled = () => { try { writeFileSync(disabledPath, JSON.stringify([...disabledSet])); } catch { /* 落盘失败不致命 */ } };
  const allBundledNames = BUNDLED_SKILLS.filter((b) => b.core).map((b) => b.name);
  const invMark = (s: { modelInvokable?: boolean; userInvocable?: boolean }) =>
    s.modelInvokable === false ? "·仅手动" : s.userInvocable === false ? "·仅自动" : "";
  const listSkills = () => [
    ...BUNDLED_SKILLS.filter((b) => b.core).map((b) => ({
      name: b.name,
      on: !disabledSet.has(b.name) && !diskNames.has(b.name),
      source: (diskNames.has(b.name) ? "内置·被覆盖" : "内置") + invMark(b),
      detail: b.description,
    })),
    ...diskSkills.map((s) => ({ name: s.name, on: !disabledSet.has(s.name), source: skillSource(s) + invMark(s), detail: s.description })),
  ];
  const setSkillEnabled = (name: string, on: boolean) => { if (on) disabledSet.delete(name); else disabledSet.add(name); persistDisabled(); };
  const batchSkills = (scope: "bundled" | "installed" | "all", on: boolean) => {
    const names = scope === "bundled" ? allBundledNames : scope === "installed" ? diskSkills.map((s) => s.name) : [...allBundledNames, ...diskSkills.map((s) => s.name)];
    toggleBundled(disabledSet, names, on);
    persistDisabled();
  };
  // 条件技能(对齐 CC 的 paths):带 paths 的技能仅当项目里有匹配文件才"在场",否则不进列表(减少无关技能稀释触发)。
  // 无 paths = 一直在场(现状)。启动一次性算定,进固定前缀、缓存安全。
  const visible = [...coreBundled, ...enabledDisk];
  const condSkills = visible.filter((s) => s.paths && s.paths.length);
  const condMatched = new Set<string>();
  if (condSkills.length > 0) {
    const pats = condSkills.map((s) => ({ name: s.name, res: s.paths!.map(globToRegExp) }));
    let scanned = 0;
    for await (const { rel } of walkFiles(workspaceRoot)) {
      if (++scanned > 4000) break; // 上限:只为判"有无匹配",不必走全量
      for (const p of pats) if (!condMatched.has(p.name) && p.res.some((re) => re.test(rel))) condMatched.add(p.name);
      if (condMatched.size === condSkills.length) break; // 全命中,提前停
    }
  }
  // 模型可见 = 核心内置 + 启用磁盘,且(无 paths 或 项目匹配)。全部进常驻列表,skill 工具按需加载正文。
  const skills = visible.filter((s) => !s.paths?.length || condMatched.has(s.name));
  // 使用频率加权(常用且最近用过的技能在发现/列表里靠前)。启动加载一次,记录时增量更新+落盘。
  let usageMap = await loadUsage(os.homedir());
  const skillsSection =
    skills.length > 0
      ? `\n\n# 可用 skill —— 开始任何任务前先扫这张表\n` +
        `【强制要求】只要某个 skill 可能与当前任务相关(哪怕只有一点可能,尤其其"何时用"写明"在…之前/必须用"的——` +
        `这类标了【触发时机】的,匹配上就该先加载),就【必须先用 skill 工具加载它、照它做,再做其它任何回应或动作】——` +
        `包括在澄清提问之前。别凭感觉直接上手而跳过它,也别只提技能名却不调用。\n` +
        `加载后,skill 正文是【必须照做的流程】(含其中"给用户选项/确认/分阶段"的步骤),不是参考——优先级高于你的默认习惯,仅让位于用户当前明确指令与安全/证据。\n` +
        // 只列【可被模型自动触发】的(modelInvokable !== false);disable-model-invocation 的不进此表,仅用户 /手动调。
        skills.filter((s) => s.modelInvokable !== false).map((s) => {
          // 触发条件(when_to_use)对"何时该加载"至关重要,必须随描述一起呈现;调用名给 slug(模型不必照抄 Title Case)。
          const trig = s.whenToUse ? ` 何时用:${s.whenToUse}` : "";
          const callName = `${s.namespace ? s.namespace + ":" : ""}${s.slug ?? s.name}`; // 插件技能用 plugin:slug 防撞
          const call = callName.toLowerCase() !== s.name.toLowerCase() ? `(调用名 ${callName})` : "";
          return `- ${s.name}${call}:${`${s.description}${trig}`.slice(0, 220)}`; // 预算上限 220 字(含触发条件),防多技能撑大常驻 prompt
        }).join("\n")
      : "";

  const systemPrompt =
    buildSystemPrompt({
      modelId: cfg.model,
      toolSummaries,
      memories: memoryText,
      cwd: workspaceRoot,
      platform: process.platform,
      projectInstructions: loadProjectInstructions(workspaceRoot), // DAO.md/AGENTS.md/CLAUDE.md + 用户级
    }) + agentTypesSection + skillsSection;

  // Ink 交互态注册的审批/提问模态(App 挂载后填入);未填则回退 readline。
  let inkApprovalPrompt: ApprovalPrompt | null = null;
  let inkAsk: ((q: string) => Promise<string>) | null = null;
  let inkAskChoice: ((q: string, opts: string[], multi?: boolean) => Promise<string>) | null = null;

  // MCP elicitation → ask 层(运行时 server 中途要结构化输入):无字段=确认;有字段=逐项收字符串,留空即取消。
  mcpElicit = async (message, requestedSchema) => {
    const askQ = (q: string) => (inkAsk ? inkAsk(q) : ask(`\n${q}\n> `));
    const propsObj = requestedSchema?.properties;
    const props = propsObj && typeof propsObj === "object" ? Object.keys(propsObj as Record<string, unknown>) : [];
    if (props.length === 0) {
      const a = (await askQ(`MCP server 请求确认:${message}(y 接受 / 其它拒绝)`)).trim().toLowerCase();
      return a === "y" || a === "yes" ? { action: "accept", content: {} } : { action: "decline" };
    }
    const content: Record<string, unknown> = {};
    for (const k of props) {
      const v = (await askQ(`MCP 输入「${k}」(${message})— 留空取消:`)).trim();
      if (!v) return { action: "cancel" };
      content[k] = v;
    }
    return { action: "accept", content };
  };

  // 长任务自主模式(--goal/--task/--coordinator / 运行时 /goal [目标]):自主连续推进 + 自动批准 + 更高轮数上限。
  // 阶段化多 agent 编排(原 Coordinator)已并入本模式,见 LONG_TASK_DIRECTIVE。
  let longTask = taskFlag;
  // YOLO(免审批,deny 之外全过,慎用):只能启动时开启——来源 --yolo / DAO_AUTO_APPROVE。
  // 长任务不再强开 yolo,改用 auto(AI 判定自动批准,见下方 permModeOverride 初始化)。
  let yolo = yoloFlag || !!process.env.DAO_AUTO_APPROVE;
  const alwaysApproved = await loadAlwaysApproved(approvalsFile);
  const readlinePrompt = makeApprovalPrompt(ask);

  void maybeCleanup(workspaceRoot); // P2-58/67 卫生清理:每日一次、非阻塞、best-effort
  void maybeCheckUpdate((msg) => process.stderr.write(`ℹ ${msg}\n`)); // P3-59 更新检查:每日一次、非阻塞、仅提示
  // ---- CC 风格权限:分层加载 settings.json(user < project < local)----
  const localSettingsFile = path.join(workspaceRoot, ".dao", "settings.local.json");
  // 优先级(低→高):user < project < local < CLI < enterprise(企业托管策略不可被下层覆盖)。
  // 仅在信任时加载 project/local;否则只用用户级,杜绝未信任目录的规则/默认模式生效。
  const lowerPerms = await loadPermissions([
    path.join(os.homedir(), ".dao", "settings.json"),
    ...(trustProject ? [path.join(workspaceRoot, ".dao", "settings.json"), localSettingsFile] : []),
  ]);
  const enterprisePerms = await loadPermissions([enterpriseSettingsPath()]);
  const loadedPerms = mergePermissions([lowerPerms, cliPerms, enterprisePerms]);
  // 本会话临时追加的 allow 规则("session"/"always" 决定产生);always 另持久化到 local。
  const sessionAllow: string[] = [];
  const getRules = () => ({ ...loadedPerms, allow: [...loadedPerms.allow, ...sessionAllow] });
  // 运行时模式覆盖(/mode acceptEdits 等);null = 用 settings 的 defaultMode。
  // --goal/--task/--coordinator 启动:用 auto(AI 判定自动批准)推进自主流程,而非 yolo 全开。
  let permModeOverride: PermissionMode | null = taskFlag && !yolo ? "auto" : null;
  // 有效权限模式:plan 会话模式 > YOLO(=bypass)> 运行时覆盖 > settings 默认 > default。
  const getMode = (): PermissionMode =>
    session.mode === "plan"
      ? "plan"
      : yolo
        ? "bypassPermissions"
        : permModeOverride ?? loadedPerms.defaultMode ?? "default";

  // auto 模式分类器:结合近期对话(用户意图 + 历史工具调用)judge 本次调用是否安全可自动批准。
  // 只回 allow/deny;出错→拒绝(fail-closed)。快速路径(白名单/工作区内编辑)已在 engine.decide 里短路,不到这里。
  const classifyPermission = async (toolName: string, argsJson: string): Promise<boolean> => {
    const gen = streamChat({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      // S3.2:权限分类是 allow/deny 二分类,flash 足够且更快更省(DAO_CLASSIFIER_MODEL 可覆盖)。
      model: process.env.DAO_CLASSIFIER_MODEL || "deepseek-v4-flash",
      messages: buildClassifierMessages(toolName, argsJson, session.messages),
      extra: { thinking: { type: "disabled" }, temperature: 0 },
      onUsage: (u) => {
        session.addUsage(u, process.env.DAO_CLASSIFIER_MODEL || "deepseek-v4-flash"); // B-2 记 flash 用量
        cacheSink.record({ agent: "classifier", depth: 0, turn: 0, model: process.env.DAO_CLASSIFIER_MODEL || "deepseek-v4-flash", usage: u, sys: "", tools: "", tail: "" });
      },
    });
    let out = "";
    let r = await gen.next();
    while (!r.done) { if (r.value.kind === "content") out += r.value.text; r = await gen.next(); }
    return /\ballow\b/i.test(out) && !/\bdeny\b/i.test(out);
  };

  const gate: ApprovalGate = new PermissionGate(
    getMode,
    getRules,
    (reqs) => (inkApprovalPrompt ?? readlinePrompt)(reqs), // Ink 态用模态,否则 readline
    (rule) => appendRule(localSettingsFile, rule, "allow"), // "always" 持久化
    (rule) => { sessionAllow.push(rule); }, // "session"/"always" 本会话生效
    classifyPermission, // auto 模式
  );

  const session = new Session(systemPrompt, cfg.model);
  // 缓存审计:根 sink。会话 store 就绪(下方)后赋值;此处先占位 no-op,
  // 让早于 store 定义的闭包(classify/子代理/压缩/蒸馏)能按引用捕获其绑定,运行时已是真 sink。
  let cacheSink: CacheAuditSink = { record() {} };
  let memoryAudit: MemoryAuditSink = { recalled() {}, wrote() {}, distilled() {} };
  let toolAudit: ToolAuditSink = { call() {} };
  let permAudit: PermAuditSink = { decided() {} };
  // 技能加载审计:同样占位,store 就绪后赋值。skillRound = 每条用户消息一轮(关联 loaded)。
  let skillSink: SkillAuditSink = { loaded() {} };
  let skillRound = 0;
  // P3-17 预算提醒阈值(￥,可选):DAO_MAX_BUDGET 设了则超阈值提醒一次(默认不停);DAO_MAX_BUDGET_HARD=1 才硬停。
  { const b = Number(process.env.DAO_MAX_BUDGET); if (Number.isFinite(b) && b > 0) session.budgetCNY = b; }
  // P0-1 前缀缓存埋点:命中率骤降(多半是压缩/注入改写了前缀)时,--verbose 下打到 stderr。
  // 前缀缓存命中比未命中省约 98%,这条日志让"压缩前后 cache 不塌"可验证。
  if (verbose) {
    session.onCacheBust(({ from, to, promptTokens, changed }) =>
      console.error(`[cache] 前缀缓存命中率骤降 ${(from * 100).toFixed(0)}%→${(to * 100).toFixed(0)}%(本回合输入 ${promptTokens} tok)${changed.length ? `——变化维度:${changed.join("/")}` : "(前缀维度未变,可能 5min TTL 过期/服务端)"}`),
    );
  }
  // settings/CLI/企业策略指定的初始模式:plan→会话只读规划;bypassPermissions→等价 YOLO。
  // default/acceptEdits 由 getMode 读 loadedPerms.defaultMode 处理,无需在此设置。
  if (loadedPerms.defaultMode === "plan") session.mode = "plan";
  else if (loadedPerms.defaultMode === "bypassPermissions") yolo = true;
  const ctx: ToolContext = {
    workspaceRoot,
    readFiles: new Set<string>(),
    readMeta: new Map<string, { mtime: number; size: number }>(),
    ask: (q: string) => (inkAsk ? inkAsk(q) : ask(`\n${q}\n> `)),
    // 结构化选择:Ink 用 数字/↑↓+Enter 选择器(多选 checkbox);非交互(stdin/eval)退回"编号 + 自由作答"。
    askChoice: async (q: string, opts: string[], multi?: boolean) => {
      if (inkAskChoice) return inkAskChoice(q, opts, multi);
      const hint = multi ? "(回逗号分隔的多个序号,或直接作答)" : "(回序号选择,或直接作答)";
      const raw = (await ask(`\n${q}\n${opts.map((o, i) => `  ${i + 1}. ${o}`).join("\n")}\n${hint}\n> `)).trim();
      const pick = (s: string) => { const n = Number(s.trim()); return Number.isInteger(n) && n >= 1 && n <= opts.length ? opts[n - 1]! : null; };
      if (multi && /[,，]/.test(raw)) {
        const picked = raw.split(/[,，]/).map(pick).filter((x): x is string => x !== null);
        return picked.length ? picked.join(", ") : raw;
      }
      return pick(raw) ?? raw;
    },
    fetchImpl: fetch,
    today,
    verifyCommand: process.env.DAO_VERIFY_CMD?.trim() || undefined,
  };

  // 子代理的直接输出在 Ink 态需静默(否则 write 到 stdout 会冲掉 Ink 渲染;其最终结果仍作工具结果展示)。
  let subagentWrite: (s: string) => void = write;
  ctx.agentTypes = agentDefs.map((d) => ({ name: d.name, description: d.description }));
  ctx.skills = skills;
  // skill 工具加载某技能后回调:累加使用频率并异步落盘(用于发现/列表加权)。
  ctx.recordSkillUse = (name: string) => { usageMap = recordUsage(usageMap, name, today); void saveUsage(os.homedir(), usageMap); skillSink.loaded(skillRound, name); };
  // 外来技能适配(无翻译字典):检测为他者所写时,用 flash 按用途转换工具名,目标词表=dao 工具注册表,按 hash 缓存。
  const apiTools = registry.toApiTools();
  const daoTools = new Set(apiTools.map((t) => t.function.name));
  const toolCatalog = apiTools.map((t) => `${t.function.name} — ${t.function.description.split(/[。\n]/)[0]!.slice(0, 60)}`).join("\n");
  const callFlash = async (system: string, user: string): Promise<string> => {
    const gen = streamChat({
      baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: "deepseek-v4-flash",
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      extra: { thinking: { type: "disabled" }, temperature: 0 },
    });
    let out = ""; let r = await gen.next();
    while (!r.done) { if (r.value?.kind === "content") out += r.value.text; r = await gen.next(); }
    if (!out && typeof r.value?.content === "string") out = r.value.content;
    return out;
  };
  ctx.adaptSkill = makeSkillAdapter({ daoTools, catalog: toolCatalog, callFlash, homeDir: os.homedir() });

  // 生命周期钩子(.dao/hooks.json + 用户级):工具前/后、用户提交、会话起止。
  // loadHooks 现为同步,收 HookFileRef[];插件 hook 文件在 <插件目录>/hooks.json,其 pluginRoot=该目录(CLAUDE_PLUGIN_ROOT)。
  const hooks = loadHooks([
    { path: path.join(os.homedir(), ".dao", "hooks.json") },
    ...pluginComp.hookFiles.map((h) => ({ path: h.file, pluginRoot: h.root })), // B-5 插件 hooks(pluginRoot=插件根,兼容 CC 的 hooks/ 子目录布局)
    // 未信任目录:不加载项目 hooks(hooks 会在事件时执行命令,是最危险的自动执行面)。
    ...(trustProject ? [{ path: path.join(workspaceRoot, ".dao", "hooks.json") }] : []),
  ]);
  ctx.preToolHook = async (toolName, argsJson) => {
    const o = await runHooks(hooks, "PreToolUse", { cwd: workspaceRoot, toolName, argsJson, payload: { tool: toolName, args: argsJson } });
    return { block: o.block, reason: o.reason, additionalContext: o.additionalContext, permissionDecision: o.permissionDecision, updatedInput: o.updatedInput };
  };
  ctx.postToolHook = async (toolName, argsJson, result) => {
    await runHooks(hooks, "PostToolUse", { cwd: workspaceRoot, toolName, argsJson, payload: { tool: toolName, args: argsJson, result } });
  };
  // SessionStart 注入(三入口共用):把 additionalContext 一次性注入,紧随系统提示。
  // 须在 resume 替换 session.messages 之后、首个回合之前调用。该注入是【每次启动重新生成】的合成前缀,
  // 会被 persist 落盘 → resume 又重放;用哨兵标记在注入前剔除上次同标记消息,使其跨多次 --continue 幂等
  // (始终只一条,内容为本次最新)。注入在 index 1(系统提示之后),首次压缩时被并入摘要;无论是否压缩都不累积。
  const SS_MARK = "[[dao:session-start-hook]]";
  const injectSessionStart = async (): Promise<void> => {
    session.messages = session.messages.filter((m) => !(m.role === "system" && typeof m.content === "string" && (m.content as string).startsWith(SS_MARK)));
    const ss = await runHooks(hooks, "SessionStart", { cwd: workspaceRoot, source: continueFlag ? "resume" : "startup" });
    if (ss.additionalContext.trim()) {
      const sysIdx = session.messages[0]?.role === "system" ? 1 : 0;
      session.messages.splice(sysIdx, 0, { role: "system", content: `${SS_MARK}\n${ss.additionalContext}` });
    }
  };
  // UserPromptSubmit 裁决(三入口共用):可阻断本次提交,或把命令输出作上下文注入。
  const gateUserPrompt = async (text: string): Promise<{ blocked: boolean; reason?: string; additionalContext?: string }> => {
    const up = await runHooks(hooks, "UserPromptSubmit", { cwd: workspaceRoot, payload: { prompt: text } });
    if (up.block) return { blocked: true, reason: up.reason };
    return { blocked: false, additionalContext: up.additionalContext.trim() ? up.additionalContext : undefined };
  };
  ctx.createWorktree = (id: string) => createWorktree(workspaceRoot, id);
  ctx.sendToTask = (id: string, message: string) => taskManager.send(id, message);
  ctx.runSubagent = ({ task, signal, agentType, workspaceRoot: wsRoot, drainPending, auditAgent = "sub", model, mode, messageParent }) => {
    // 省略 agent_type 时默认用 general-purpose(对齐 CC);找不到该内置则回退裸 systemPrompt。
    const def = agentDefs.find((d) => d.name === (agentType ?? "general-purpose"));
    const sp = def ? `${systemPrompt}\n\n# 你的专用角色(${def.name})\n${def.prompt}` : systemPrompt;
    let reg = def?.tools ? registry.subset(new Set(def.tools)) : registry;
    if (def?.toolsExclude?.length) reg = reg.subsetExcluding(new Set(def.toolsExclude));
    const subModel = model ?? def?.model ?? session.model;     // 优先级:调用级 > 类型 > 会话
    const subMode = mode ?? session.mode;
    const subCtx = {
      ...(wsRoot ? { ...ctx, workspaceRoot: wsRoot } : ctx), // worktree 隔离:覆盖工作区根
      ...(messageParent ? { messageParent } : {}),           // 后台子代理→父 mid-run 出口(仅 runBackgroundAgent 绑定)
    };
    return runSubagent({
      task,
      systemPrompt: sp,
      model: subModel,
      mode: subMode,
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
      auditSink: cacheSink,
      auditAgent,
      auditSubId: Math.random().toString(36).slice(2, 6),
    });
  };

  // ② fork 子代理:用父对话已缓存前缀做起点(复用缓存),全量 system/工具/模型与父一致。
  ctx.runForkAgent = (task: string, signal?: AbortSignal, drainPending?: () => string[]) => {
    // 剪掉尾部"未配对的 assistant(tool_calls)/tool"消息,使前缀以完整交换收尾(可合法追加 user);
    // 这段前缀正是此前回合发过的、已被缓存的内容。
    const fork = [...session.messages];
    while (fork.length && (fork[fork.length - 1]!.role === "tool" || (fork[fork.length - 1]!.role === "assistant" && (fork[fork.length - 1] as { tool_calls?: unknown }).tool_calls))) fork.pop();
    return runSubagent({
      task, systemPrompt, model: session.model, mode: session.mode,
      config: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey },
      registry, ctx, gate, streamChat, executeToolCalls, write: subagentWrite, runTurn,
      signal, drainPending, forkMessages: fork,
      auditSink: cacheSink, auditAgent: "fork", auditSubId: Math.random().toString(36).slice(2, 6),
    });
  };

  // 后台任务管理器:异步子代理 + 通知队列(主循环不阻塞)。
  const taskManager = createTaskManager();
  ctx.runBackgroundAgent = (task: string, agentType?: string) =>
    taskManager.launch(`${agentType ? `[${agentType}] ` : ""}${task.slice(0, 50)}`, (signal, id) =>
      ctx.runSubagent!({
        task, signal, agentType,
        drainPending: () => taskManager.drainPending(id),
        auditAgent: "bg",
        messageParent: (m) => { taskManager.emitFromTask(id, m); },
      }),
    );
  ctx.adoptBackground = (description: string, promise: Promise<string>) => taskManager.adopt(description, promise);

  // 申请访问工作区外路径(读类工具):一次授权后本会话不再追问;选"本仓库后续都用"则持久化。
  let externalReadGranted = alwaysApproved.has("external-read");
  let externalWriteGranted = alwaysApproved.has("external-write");
  // CC additionalDirectories:settings 里预先授权的工作区外目录,直接放行不弹窗。
  const extraDirs = loadedPerms.additionalDirectories.map((d) => path.resolve(workspaceRoot, d));
  const underExtra = (abs: string) => extraDirs.some((d) => abs === d || abs.startsWith(d.endsWith("/") ? d : d + "/"));
  // dao 自管的 skill/插件目录:skill 正文常引同目录伴随文件(如 superpowers 的 implementer-prompt.md),
  // 它们在区外但是受信内容,【只读】放行不追问(写仍走审批——故只用于 approveExternalRead,不进 extraDirs)。
  const daoSkillDirs = [path.join(os.homedir(), ".dao", "skills"), path.join(os.homedir(), ".dao", "plugins")];
  const underDaoSkills = (abs: string) => daoSkillDirs.some((d) => abs.startsWith(d.endsWith("/") ? d : d + "/"));
  ctx.approveExternalRead = async (abs: string): Promise<boolean> => {
    if (yolo || externalReadGranted || underExtra(abs) || underDaoSkills(abs)) return true; // dao skill/插件资源:只读放行
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
  // L2.1:上下文窗口可被 env 覆盖(目标模型真实窗口若 <1M 必须设对,否则压缩永不触发→真实上限处崩)。
  // 真正的安全网是反应式压缩(见 loop.ts compact 钩子):即便此值偏大,撞上下文超限也会自动压缩重试。
  const CONTEXT_WINDOW = Number(process.env.DAO_CONTEXT_WINDOW) || 1_000_000;
  // Q1 当前上下文 token:优先用主模型上次真实 prompt_tokens(准,尤其中文),无则回退 chars/3 估算。
  const contextTokens = () => session.lastPromptTokens ?? estimateTokens(session.messages);
  // L1.3:主模型持续过载/异常时本回合回退的模型;DAO_FALLBACK_MODEL=off 关闭。
  const FALLBACK_MODEL = process.env.DAO_FALLBACK_MODEL === "off" ? undefined : (process.env.DAO_FALLBACK_MODEL || "deepseek-v4-flash");
  const FLASH_MODEL = "deepseek-v4-flash";
  // P2-11 编辑后诊断命令(如 "tsc --noEmit"):设了才在写/改文件后跑、把报错回灌模型。
  // 显式 DAO_DIAGNOSTICS_CMD 优先;否则 DAO_DIAGNOSTICS=1 时按项目自动探测(tsc/eslint)。默认不跑。
  const DIAG_CMD = process.env.DAO_DIAGNOSTICS_CMD?.trim()
    || (process.env.DAO_DIAGNOSTICS === "1" ? detectDiagnosticsCmd(workspaceRoot) : undefined);
  const makeDiagnose = (signal?: AbortSignal) => (DIAG_CMD ? () => runDiagnosticsCmd(DIAG_CMD, workspaceRoot, signal) : undefined);

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
      // L2.5:摘要任务用便宜的 flash 即可,省钱更快(DAO_SUMMARY_MODEL 可覆盖)。
      model: process.env.DAO_SUMMARY_MODEL || FLASH_MODEL,
      messages: [
        { role: "system", content: COMPACT_PROMPT },
        { role: "user", content: rendered },
      ],
      // 摘要不需要深推理:关思考更快更省,温度 0 让压缩结果可复现。
      extra: { thinking: { type: "disabled" }, temperature: 0 },
      onUsage: (u) => {
        session.addUsage(u, process.env.DAO_SUMMARY_MODEL || FLASH_MODEL); // B-2 记摘要用量
        cacheSink.record({ agent: "summary", depth: 0, turn: 0, model: process.env.DAO_SUMMARY_MODEL || FLASH_MODEL, usage: u, sys: "", tools: "", tail: "" });
      },
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

  // L2.4 压缩熔断:连续 3 次摘要失败 → 直接抛(让 compactMessages 走硬截断兜底),不再浪费模型调用。
  // 成功一次即复位。配合 compact.ts 的硬截断,长任务永不因压缩失败而中断。
  let compactFails = 0;
  const summarizeWithBreaker = async (msgs: ChatMessage[]): Promise<string> => {
    if (compactFails >= 3) throw new Error("压缩熔断:连续摘要失败,改用硬截断");
    try { const s = await summarize(msgs); compactFails = 0; return s; }
    catch (e) { compactFails++; throw e; }
  };

  const runCompaction = async (): Promise<void> => {
    // 按 token 量判断(而非消息条数):单轮长任务的 microcompact 清旧工具结果会降 token、不改条数,
    // 用条数会误报"无需压缩"。token 减少才是真压缩的信号。
    const before = estimateTokens(session.messages);
    session.messages = await compactMessages(
      session.messages,
      { keepRecentTurns: KEEP_RECENT_TURNS, summarize: summarizeWithBreaker },
      todoStore.get().length ? formatTodos(todoStore.get()) : undefined,
    );
    const after = estimateTokens(session.messages);
    write(after < before ? `\n[已压缩对话:~${before.toLocaleString()} → ~${after.toLocaleString()} tok]\n` : `\n[对话较短,无需压缩]\n`);
  };

  // P3-63 防休眠 + 长回合完成通知:回合期间持 wakelock;耗时超阈值则完成时弹桌面通知。
  const NOTIFY_MIN_MS = Number(process.env.DAO_NOTIFY_MIN_MS) || 30000;
  const withPresence = async <T>(fn: () => Promise<T>): Promise<T> => {
    const release = acquireWakeLock();
    const start = Date.now();
    try { return await fn(); }
    finally {
      release();
      const ms = Date.now() - start;
      if (ms > NOTIFY_MIN_MS) notify("dao", `完成一轮(${Math.round(ms / 1000)}s)`);
    }
  };

  const runOneTurn = async () => {
    await withPresence(() => runTurn({
      session,
      config: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey },
      registry,
      ctx,
      auditSink: cacheSink,
      auditId: { agent: "main", depth: 0 },
      gate,
      streamChat,
      executeToolCalls,
      write,
      compact: runCompaction, // L2.2 反应式压缩
      fallbackModel: FALLBACK_MODEL, // L1.3 模型回退
      diagnose: makeDiagnose(), // P2-11 编辑后诊断
      reflect: argvPrompt ? undefined : reflect, // 反思层:一次性/eval 不反思
      longTask, // 纠偏者仅长任务按周期触发
      drainAdvisories: () => replyChallenge.drain(), // 路径①:异步挑战者结论回合边界注入
    }));
    // 写入层(缺陷#1):热回合边界增量蒸馏——门控、后台;压缩前同步先捕获(防 compact 改 messages 竞态)。
    // 一次性/eval 路径(argvPrompt)不捕获:保持快速查询零 flash 开销、eval 测量干净。
    if (!argvPrompt) {
      const compactionImminent = contextTokens() >= CONTEXT_WINDOW * 0.85;
      const newTokens = estimateTokens(session.messages) - lastDistillTokens;
      if (shouldCaptureMemory({ newTokens, threshold: DISTILL_TOKENS, compactionImminent }).capture) {
        if (compactionImminent) await captureMemories({ incremental: true });
        else void captureMemories({ incremental: true });
      }
    }
    if (contextTokens() >= CONTEXT_WINDOW * 0.85) {
      write("\n[接近上限,自动压缩…]\n");
      await runCompaction();
    }
  };

  // Ink 态压缩:不向 stdout 写(会冲渲染),只压缩消息;提示由 App 通过 events/notice 给出。
  const inkCompact = async (): Promise<void> => {
    session.messages = await compactMessages(
      session.messages,
      { keepRecentTurns: KEEP_RECENT_TURNS, summarize: summarizeWithBreaker },
      todoStore.get().length ? formatTodos(todoStore.get()) : undefined,
    );
  };

  // 写入层(缺陷#1):记忆捕获 = fork 增量蒸 → 去重 upsert。在【热回合边界】调用(增量、可后台)。
  // fork 默认开:复用主对话前缀缓存(同主模型,热则近免费);DAO_DISTILL_FORK=0 退 flash。
  // 退出时【不再】触发——everything 已在热边界增量捕获过,退出蒸馏只会撞冷缓存全价。
  let captureBusy = false; // 防并发:上一次后台蒸馏未完成则跳过本次
  let lastDistillTokens = 0; // 增量标记:上次成功蒸馏时的对话 token 估算(决定"新增多少")
  const captureMemories = async (opts?: { incremental?: boolean }): Promise<void> => {
    if (captureBusy) return;
    if (!session.messages.some((m) => m.role === "user")) return;
    captureBusy = true;
    try {
      const fork = process.env.DAO_DISTILL_FORK !== "0";
      const distillModel = fork ? session.model : "deepseek-v4-flash";
      // 只发【上一次主请求已缓存的前缀】(slice 到 lastSentLength),不含回合后追加的最终回应/中途注入——
      // 否则那截未缓存内容会拉低命中(实测子代理大回合命中崩到 0.19)。fork 才需要对齐缓存;非 fork 走截断。
      const distillTools = fork ? apiToolsForMode(registry, session.mode) : undefined;
      const distillMsgs = fork && session.lastSentLength > 0 ? session.messages.slice(0, session.lastSentLength) : session.messages;
      const cands = await distill({
        streamChat,
        config: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey },
        model: distillModel,
        messages: distillMsgs,
        today,
        fork,
        incremental: opts?.incremental,
        // fork 缓存复用:带上与主循环【同一份 tools + 同思考强度】,前缀才字节一致、命中热缓存。
        tools: distillTools,
        reasoningEffort: process.env.DAO_REASONING_EFFORT || "max",
        onUsage: (u) => {
          session.addUsage(u as never, distillModel); // B-2 计入蒸馏用量
          // 审计记【真 raw 指纹】(cache_audit 内部自己 hash,与主循环同算法)→ 便于下次对比 distill vs main 前缀是否一致。
          const sysRaw = typeof session.messages[0]?.content === "string" ? (session.messages[0]!.content as string) : "";
          // msgs=实发消息体前缀(不含 distill 尾部追加的抽取指令)→ 与末轮 main 比对应逐字节一致。
          cacheSink.record({ agent: "distill", depth: 0, turn: 0, model: distillModel, usage: u as never, sys: sysRaw, tools: JSON.stringify(distillTools ?? []), tail: "", msgs: JSON.stringify(distillMsgs) });
        },
      });
      // 灰区(字符相似度抓不住的改写式近重复)交 flash 裁判判是否合并。
      const adjudicate = makeFlashAdjudicator(streamChat, { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
      let added = 0, updated = 0;
      for (const cand of cands) {
        const existing = await loadAllMemories(projectMemoryDir, userMemoryDir, knowledgeMemoryDir);
        // 本地优先路由:没把握的推断(confidence<0.6)落项目级不污染全局;否则按类型进对应层。
        const scope = routeScope(cand.type);
        const dir = scope === "knowledge" ? knowledgeMemoryDir : scope === "user" ? userMemoryDir : projectMemoryDir;
        const res = await upsertMemory(dir, cand, existing, adjudicate);
        if (res.action === "updated") updated++; else added++;
      }
      memoryAudit.distilled(cands.length, added, updated);
      lastDistillTokens = estimateTokens(session.messages); // 成功后更新增量标记(失败则不更新,下回合重试该切片)
    } catch (e) {
      if (process.env.DAO_DEBUG_MEMORY) console.error("[distill] 蒸馏失败:", e);
      // 失败静默,不阻塞会话。
    } finally {
      captureBusy = false;
    }
  };
  // 触发阈值:自上次蒸以来新增对话 token ≥ 此值即捕获(锚"一块真实新工作量",非压缩阈值;可调)。
  const DISTILL_TOKENS = Number(process.env.DAO_DISTILL_TOKENS) || 15000;

  // 反思层 fork:同模型(命中主对话热缓存)对进展做精简复核,返回结论(由 loop 作 advisory 注入参考)。
  // DAO_REFLECT=0 关闭。失败静默返回 null,绝不影响主流程。
  const reflect = async (kind: "challenger" | "refocuser"): Promise<string | null> => {
    if (process.env.DAO_REFLECT === "0") return null;
    try {
      const tail = kind === "challenger" ? CHALLENGER_PROMPT : REFOCUSER_PROMPT;
      const gen = streamChat({
        baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: session.model,
        messages: [...session.messages, { role: "user", content: tail }],
        extra: { temperature: 0 },
        onUsage: (u) => session.addUsage(u as never, session.model),
      });
      let out = ""; let r = await gen.next();
      while (!r.done) { if (r.value?.kind === "content") out += r.value.text; r = await gen.next(); }
      if (!out && typeof r.value?.content === "string") out = r.value.content;
      return out.trim() || null;
    } catch {
      return null;
    }
  };

  // 路径①:用户反复申诉 → 异步挑战者。仅交互式接(argv 一次性不接此入口)。阈值默认 0.15(短 CJK 重提约 0.2,偏召回);DAO_CHALLENGE_REPEAT_SIM=0 关。
  const replyChallenge = createReplyChallenge({
    reflect: () => reflect("challenger"),
    threshold: process.env.DAO_CHALLENGE_REPEAT_SIM !== undefined ? Number(process.env.DAO_CHALLENGE_REPEAT_SIM) : 0.15,
  });

  let exitSessionId: string | undefined; // 交互会话 id(供退出时打印 resume 提示;一次性路径无 store)
  try {
    if (argvPrompt) {
      // 一次性调用(含 eval 每次跑)不蒸馏:蒸馏只属于真实的交互式工作会话,
      // 既省掉快速查询的 flash 开销,也自动把 eval 排除在外、测量更干净。
      // 同理不做缓存审计:此路径无会话 store/id(无从按 id 审计),cacheSink 保持 no-op。
      // hook 钩子:SessionStart 注入 + UserPromptSubmit 裁决 + SessionEnd(与交互态同等防护;对齐 CC——headless `-p` 一次性运行同样触发 SessionEnd)。
      await injectSessionStart();
      const up = await gateUserPrompt(argvPrompt);
      if (up.blocked) { write(`[提交被 hook 阻止] ${up.reason || ""}\n`); return; }
      session.addUser(argvPrompt);
      if (up.additionalContext) session.messages.push({ role: "system", content: `[hook 注入的上下文]\n${up.additionalContext}` });
      await runOneTurn();
      await runHooks(hooks, "SessionEnd", { cwd: workspaceRoot }); // 会话结束钩子(CC 对等:一次性运行也触发)
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
      exitSessionId = store.id; // 记下,退出时给 resume 提示
      // 缓存审计:主+子+fork+后台+三工具调用全写进 store.dir/cache.jsonl(常驻静默;DAO_CACHE_AUDIT=0 关)。
      cacheSink = createCacheAuditSink(store.dir);
      memoryAudit = createMemoryAuditSink(store.dir);
      toolAudit = createToolAuditSink(store.dir);
      permAudit = createPermAuditSink(store.dir, getMode);
      ctx.toolAudit = toolAudit; ctx.permAudit = permAudit; ctx.memoryAudit = memoryAudit;
      memoryAudit.recalled(injectedMems.length, recallStale, recallChanged, recallTypes);
      try {
        if (auditEnabled(process.env, "SKILL")) {
          writeFileSync(path.join(store.dir, "skills-catalog.json"),
            JSON.stringify(skills.map((s) => ({ name: s.name, description: s.description, whenToUse: s.whenToUse ?? "" }))));
        }
      } catch { /* 快照失败不影响 */ }
      skillSink = createSkillAuditSink(store.dir);
      const ckpt = createCheckpointer(workspaceRoot);
      const turnCheckpoints: (string | null)[] = []; // 第 k 项 = 第 k 条用户消息【之前】的影子 git 快照 sha,供 /rewind 联动回滚文件
      let sessionTitle: string | undefined; // /rename 设置
      if (longTask && !continueFlag) session.messages.push({ role: "system", content: LONG_TASK_DIRECTIVE });
      await injectSessionStart(); // SessionStart 注入(resume 替换后、首个回合前;幂等见 injectSessionStart)
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
          const up = await gateUserPrompt(text);
          if (up.blocked) { events.notice(`[提交被 hook 阻止] ${up.reason || ""}`); return; }
          turnCheckpoints.push(ckpt.snapshot(`回合前: ${text.slice(0, 60)}`)); // 回合前快照(供 /restore 与 /rewind code 回退)
          store.append({ t: "user", text });
          session.addUser(text);
          void replyChallenge.onUserMessage(text); // 路径①:命中相似度门才异步 fork 挑战者(非阻塞)
          skillRound++; // 新一轮:用于关联本轮 skill 加载(skillSink.loaded);模型从常驻技能列表按需加载,无 discovery 预筛。
          if (up.additionalContext) session.messages.push({ role: "system", content: `[hook 注入的上下文]\n${up.additionalContext}` });
          await withPresence(() => runTurn({
            session,
            config: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey },
            registry,
            ctx,
            auditSink: cacheSink,
            auditId: { agent: "main", depth: 0 },
            gate,
            streamChat,
            executeToolCalls,
            write: () => {},
            compact: inkCompact, // L2.2 反应式压缩
            fallbackModel: FALLBACK_MODEL, // L1.3 模型回退
            diagnose: makeDiagnose(signal), // P2-11 编辑后诊断
            reflect, // 反思层:卡住→挑战者、长任务漂移→纠偏者
            longTask, // 纠偏者仅长任务按周期触发
            drainAdvisories: () => replyChallenge.drain(), // 路径①:异步挑战者结论回合边界注入
            events: logEvents(events, store), // 渲染的同时写日志
            // 主会话不限轮数(对标 CC main session):靠 token 预算触发自动 compact;DAO_MAX_TURNS 可设硬上限(eval 用)。
            signal,
          }));
          store.append({ t: "turn_end" });
          // 写入层(缺陷#1):热回合边界增量蒸馏——门控、后台;压缩前必须先捕获(同步,防 compact 改 messages 竞态)。
          {
            const compactionImminent = contextTokens() >= CONTEXT_WINDOW * 0.85;
            const newTokens = estimateTokens(session.messages) - lastDistillTokens;
            if (shouldCaptureMemory({ newTokens, threshold: DISTILL_TOKENS, compactionImminent }).capture) {
              if (compactionImminent) await captureMemories({ incremental: true }); // 压缩前同步捕获
              else void captureMemories({ incremental: true }); // 否则后台,不阻塞下一轮 prompt
            }
          }
          if (contextTokens() >= CONTEXT_WINDOW * 0.85) {
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
            const bundledCore = BUNDLED_SKILLS.filter((b) => b.core);
            const bundledNames = bundledCore.map((b) => b.name);
            const persist = () => { try { writeFileSync(disabledPath, JSON.stringify([...disabledSet])); } catch {} };
            const installedNames = diskSkills.map((s) => s.name);
            // 批量开关:/skills <bundled|installed|all> off|on(bundled=内置,installed=第三方/项目·用户·插件,all=全部)
            if ((sub === "bundled" || sub === "installed" || sub === "all") && (rest[1] === "off" || rest[1] === "on")) {
              const names = sub === "bundled" ? bundledNames : sub === "installed" ? installedNames : [...bundledNames, ...installedNames];
              const label = sub === "bundled" ? "内置" : sub === "installed" ? "第三方" : "全部";
              toggleBundled(disabledSet, names, rest[1] === "on");
              persist();
              return { handled: true, output: `已${rest[1] === "on" ? "开启" : "关闭"}${label}技能(${names.length} 个,重启 dao 生效)` };
            }
            if (sub === "off" || sub === "on") {
              const target = rest[1];
              const known = target && (bundledNames.includes(target) || diskSkills.some((s) => s.name === target));
              if (!known) return { handled: true, output: `未知技能:${target ?? "(空)"}。/skills 看列表;批量用 /skills <bundled|installed|all> off|on` };
              if (sub === "off") disabledSet.add(target!); else disabledSet.delete(target!);
              persist();
              return { handled: true, output: `已${sub === "off" ? "禁用" : "启用"}技能 ${target}(重启 dao 生效)` };
            }
            // 列表:内置 + 项目/用户。内置被同名磁盘技能覆盖时标注,避免"静默消失"。
            const bundledRows = bundledCore.map((b) => {
              const shadow = diskNames.has(b.name);
              const state = shadow ? "▷ 覆 " : disabledSet.has(b.name) ? "○ off" : "● on ";
              const tag = shadow ? `内置·被${skillSource(diskSkills.find((s) => s.name === b.name)!)}覆盖` : "内置";
              return `${state}  ${b.name}  ·  ${tag}  ·  ~${skillTokens(b)} tok  ·  ${b.description.slice(0, 48)}`;
            });
            const diskRows = diskSkills.map((s) => `${disabledSet.has(s.name) ? "○ off" : "● on "}  ${s.name}  ·  ${skillSource(s)}  ·  ~${skillTokens(s)} tok  ·  ${s.description.slice(0, 48)}`);
            const rows = [...bundledRows, ...diskRows];
            const bundledOn = bundledCore.filter((b) => !disabledSet.has(b.name) && !diskNames.has(b.name)).length;
            const diskOn = diskSkills.filter((s) => !disabledSet.has(s.name)).length;
            const head = `技能(内置 ${bundledOn}/${bundledCore.length} 开 · 第三方 ${diskOn}/${diskSkills.length} 开;on 的描述常驻上下文、模型按需加载正文)`;
            const foot = `/skills off|on <名> 开关单个(内置也可关);/skills <bundled|installed|all> off|on 批量(内置/第三方/全部);重启生效`;
            return { handled: true, output: `${head}\n${rows.join("\n")}\n${foot}` };
          }
          if (name === "context") {
            const used = contextTokens();
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
            return { handled: true, output: "MCP 服务器:\n" + mcp.servers.map((s) => `  ${s.ok ? "✓" : "✗"} ${s.name} · ${s.tools} 工具${s.resources ? ` · ${s.resources} 资源` : ""}${s.prompts ? ` · ${s.prompts} 提示` : ""}${s.error ? ` · ${s.error}` : ""}`).join("\n") };
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
            checks.push(cfg.apiKey ? `✓ API key 已配置(来源 ${keySource})` : "✗ 缺 API key(设 DEEPSEEK_API_KEY 或写 ~/.dao/config.json)");
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
            const rest = line.trim().split(/\s+/).slice(1);
            const today = new Date().toISOString().slice(0, 10);
            if (rest[0] === "delete" || rest[0] === "rm" || rest[0] === "forget") {
              const targets = rest.slice(1);
              if (!targets.length) return { handled: true, output: "用法:/memory delete <名> [名…](名见 /memory 审核报告)" };
              const done: string[] = [], miss: string[] = [];
              for (const t of targets) {
                let hit = false;
                for (const [, dir] of tiers) {
                  const fp = path.join(dir, `${t}.md`);
                  try { rmSync(fp); hit = true; break; } catch { /* 该层没有 */ }
                }
                (hit ? done : miss).push(t);
              }
              return { handled: true, output: `${done.length ? `已删除:${done.join(", ")}` : ""}${miss.length ? `\n未找到:${miss.join(", ")}` : ""}`.trim() || "无操作" };
            }
            return { handled: true, output: formatAudit(gatherAudit(tiers, today), today) };
          }
          if (name === "permissions") {
            const r = getRules();
            const fmt = (label: string, arr: string[]) => `${label}:${arr.length ? arr.join(", ") : "(无)"}`;
            return { handled: true, output: `权限规则(模式 ${getMode()};deny>ask>allow):\n  ${fmt("allow", r.allow)}\n  ${fmt("ask", r.ask)}\n  ${fmt("deny", r.deny)}\n(改 .dao/settings.json 的 permissions)` };
          }
          if (name === "session") {
            const title = sessionTitle ? sessionTitle : "(未命名,用 /rename 命名)";
            const cachePath = path.join(store.dir, "cache.jsonl");
            return { handled: true, output:
              `会话 · ${store.id}\n` +
              `  标题:${title}\n` +
              `  目录:${store.dir}\n` +
              `  工作区:${workspaceRoot}\n` +
              `  模型:${session.model} · 模式:${session.mode}\n` +
              `  消息:${session.messages.length} 条\n` +
              `  缓存审计:${cachePath}(/audit cache 查看)` };
          }
          if (name === "audit") {
            const parts = line.trim().split(/\s+/);
            const sub = parts[1];
            const id = parts[2];
            const dir = id ? path.join(sessionsDir, id) : store.dir;
            const valid = ["memory", "tools", "perms", "cache", "skills", "all"];
            if (!sub || !valid.includes(sub)) return { handled: true, output: `用法:/audit <memory|tools|perms|cache|skills|all> [会话id]\n默认审当前会话(${store.id})。` };
            const readJsonl = (file: string): Record<string, unknown>[] => {
              try {
                return readFileSync(path.join(dir, file), "utf8").trim().split("\n").filter(Boolean)
                  .flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
              } catch { return []; }
            };
            const sections: string[] = [];
            const want = (k: string) => sub === "all" || sub === k;
            if (want("memory")) sections.push(formatMemoryReport(summarizeMemoryTrace(readJsonl("memory-trace.jsonl") as never)));
            if (want("tools")) sections.push(formatToolReport(summarizeToolTrace(readJsonl("tool-trace.jsonl") as never)));
            if (want("perms")) sections.push(formatPermReport(summarizePermTrace(readJsonl("perm-trace.jsonl") as never)));
            if (want("cache")) sections.push(formatCacheReport(readJsonl("cache.jsonl") as never));
            if (want("skills")) sections.push(formatSkillReport(summarizeSkillTrace(readAllSkillTraces(sessionsDir))));
            const head = `审计 · 会话 ${id ?? store.id} · 目录 ${dir}\n`;
            return { handled: true, output: head + sections.join("\n\n") };
          }
          if (name === "resume") {
            const id = line.trim().split(/\s+/)[1];
            // P3-29 秒列:只读轻量 meta(不解析整份 state.json),并按最近更新排序。
            const metas = listSessions(sessionsDir);
            if (metas.length === 0) return { handled: true, output: "本工作区无历史会话。" };
            if (!id) return { handled: true, output: `历史会话(${metas.length}):\n` + metas.slice(0, 15).map((m) => `  ${m.id}${m.title ? ` — ${m.title}` : ""}${m.done ? "" : " ·未完成"}`).join("\n") + "\n用 /resume <会话id> 载入其上下文。" };
            const st = loadState(sessionsDir, id);
            if (!st) return { handled: true, output: `未找到会话:${id}(/resume 看列表)` };
            session.messages = st.messages; // 整盘载入上下文(继续写入当前会话文件,不动原文件)
            session.setModel(st.model);
            // 重放末段对话作回顾,让用户一眼看到"上次做到哪"(只取文本 user/assistant,末 6 条)。
            const recap = transcriptFromMessages(st.messages);
            const tail = recap.slice(-6);
            const resumeItems: TranscriptItem[] = tail.length
              ? [{ id: 0, kind: "notice", text: `── 会话 ${id} 最近对话(共 ${st.messages.length} 条消息,显示末 ${tail.length} 条)──` }, ...tail]
              : [];
            return { handled: true, output: `✓ 已载入会话 ${id},继续写入当前会话。`, clearTranscript: true, resumeItems };
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
              else {
                ckpt.snapshot("回退前自动快照"); // 先存当前状态,回退可逆
                codeMsg = ckpt.restore(sha) ? " 文件已回滚到该节点(真实 git 提交未动;回退前状态已存为\"回退前自动快照\")。" : " 文件回滚失败。";
              }
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
            return { handled: true, output: `配置:\n  模型 ${cfg.model} · baseUrl ${cfg.baseUrl} · 权限模式 ${getMode()}\n  账户 profile ${profilesCfg.activeProfile} · key 来源 ${keySource}(/account 管理多 key)\n  设置文件:~/.dao/settings.json(用户)· <项目>/.dao/settings.json · .dao/settings.local.json\n(编辑这些文件改配置;权限规则见 /permissions,MCP 见 ~/.dao/mcp.json)` };
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
            const pct = Math.round((contextTokens() / CONTEXT_WINDOW) * 100);
            const flags = [yolo ? "免审批" : "", longTask ? "长任务" : ""].filter(Boolean).join("/") || "—";
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
          if (name === "hooks") {
            const lines = hooks.map((h) => `  ${h.event}${h.matcher ? `[${h.matcher}]` : ""}: ${h.type === "command" ? h.command : h.type}`);
            if (lines.length === 0) return { handled: true, output: "未配置 hooks。在 ~/.dao/hooks.json 或 <项目>/.dao/hooks.json 配(事件:PreToolUse/PostToolUse/UserPromptSubmit/SessionStart/SessionEnd)。" };
            return { handled: true, output: `已配置 hooks:\n${lines.join("\n")}` };
          }
          if (name === "agents") {
            const types = ctx.agentTypes ?? [];
            if (types.length === 0) return { handled: true, output: "无自定义子代理类型(默认通用子代理可用)。在 .dao/agents/ 定义后用 agent 工具的 agent_type 调。" };
            return { handled: true, output: `可用子代理类型(${types.length}):\n` + types.map((t) => `  ${t.name} — ${t.description}`).join("\n") };
          }
          if (name === "files") {
            const files = [...(ctx.readFiles ?? [])].map((f) => path.relative(workspaceRoot, f) || f);
            if (files.length === 0) return { handled: true, output: "本会话尚未读取任何文件。" };
            return { handled: true, output: `上下文中读过的文件(${files.length}):\n` + files.slice(0, 50).map((f) => "  " + f).join("\n") + (files.length > 50 ? `\n  …等共 ${files.length} 个` : "") };
          }
          if (name === "copy") {
            const last = [...session.messages].reverse().find((m) => m.role === "assistant" && typeof m.content === "string" && (m.content as string).trim());
            if (!last) return { handled: true, output: "没有可复制的回答。" };
            const text = last.content as string;
            const cmd = process.platform === "darwin" ? "pbcopy" : process.platform === "win32" ? "clip" : "xclip -selection clipboard";
            try { execSync(cmd, { input: text }); return { handled: true, output: `已复制最后一条回答到剪贴板(${text.length} 字)。` }; }
            catch { return { handled: true, output: "复制失败(未找到剪贴板工具:macOS 用 pbcopy,Linux 装 xclip)。" }; }
          }
          if (name === "btw") {
            const note = line.trim().split(/\s+/).slice(1).join(" ").trim();
            if (!note) return { handled: true, output: "用法:/btw <随手备注>(加入上下文供模型参考,不触发动作)" };
            session.messages.push({ role: "system", content: `[用户备注] ${note}` });
            return { handled: true, output: "已记入上下文(下次回复时模型会看到)。" };
          }
          // /account /login 的无参交互(选择器 / 粘贴引导)由 App 拦截;这里只处理带参的"高手快捷"文本路径。
          if (name === "account" || name === "accounts") {
            const [target, ...restA] = line.trim().split(/\s+/).slice(1);
            if (target === "rm" && restA[0]) {
              if (!profilesCfg.profiles[restA[0]]) return { handled: true, output: `无此账户:${restA[0]}` };
              removeAccount(restA[0]);
              return { handled: true, output: `✓ 已删除账户「${restA[0]}」。当前:${profilesCfg.activeProfile}` };
            }
            if (target) {
              if (!profilesCfg.profiles[target]) return { handled: true, output: `无此账户:${target}(/account 看列表)` };
              return switchAccount(target)
                ? { handled: true, output: `✓ 已切到账户「${target}」,下一回合生效。` }
                : { handled: true, output: `切换失败:${target}` };
            }
            // 无参且无选择器(非 Ink/退化):退回文本列表
            const rows = listAccounts();
            const list = rows.length ? rows.map((r) => `${r.active ? "● " : "  "}${r.name} · ${r.detail}`).join("\n") : "  (无,/login 添加)";
            return { handled: true, output: `账户 · 当前来源 ${keySource}\n${list}\n(Ink 下直接 /account 弹选择器;/account <名> 切换 · /account rm <名> 删除)` };
          }
          if (name === "login") {
            const key = line.trim().split(/\s+/).slice(1).join(" ").trim();
            if (!key) return { handled: true, output: "用法:直接 /login 走粘贴引导;/login <key> 给当前账户换 key;/logout 清除。" };
            cfg.apiKey = key; // 即时生效(非阻塞);完整校验在 /login 引导或启动 wizard
            const targetName = profilesCfg.profiles[profilesCfg.activeProfile] ? profilesCfg.activeProfile : "default";
            const cur = profilesCfg.profiles[targetName];
            const meta = cur ? { provider: cur.provider, baseUrl: cur.baseUrl, model: cur.model } : { provider: "deepseek" as const, ...DEFAULTS.deepseek };
            persistKey(profilesCfg, targetName, meta, key, kc, { preferKeychain: keychainAvailable() })
              .then((res) => { profilesCfg = { ...res.cfg, onboardingComplete: true }; keySource = `profile:${targetName}`; return saveProfiles(keyFile, profilesCfg); })
              .catch(() => {});
            return { handled: true, output: `✓ 已给账户「${targetName}」换 key,下一回合生效。` };
          }
          if (name === "logout") {
            const active = profilesCfg.activeProfile;
            removeAccount(active);
            return { handled: true, output: `✓ 已清除账户「${active}」的 key。本会话仍用当前 key;重启后需 /login。` };
          }
          if (name === "bypass" || name === "yolo") { // /yolo 保留为别名
            // yolo 只能启动时开(`dao --yolo`);会话内只允许【关闭】,不允许开启。
            if (!yolo) return { handled: true, output: "※ yolo(免审批)只能启动时开启:`dao --yolo`。会话内想自动批准请用 /mode auto(AI 判定,deny/敏感仍拦)。" };
            yolo = false;
            return { handled: true, output: "免审批已关闭:恢复审批门。" };
          }
          if (name === "mode") {
            const arg = line.trim().split(/\s+/)[1];
            if (!arg) {
              return { handled: true, output: `当前权限模式:${getMode()}。用法:/mode <default|acceptEdits|auto|plan>(yolo 只能 \`dao --yolo\` 启动时开)` };
            }
            if (arg === "plan") { session.mode = "plan"; permModeOverride = null; return { handled: true, output: "◇ 已切到 plan(只读规划,拦写/执行)" }; }
            if (arg === "bypassPermissions") return { handled: true, output: "※ yolo(bypassPermissions)只能 `dao --yolo` 启动时开启,不能会话内切换。会话内可用 /mode auto。" };
            if (arg === "default" || arg === "acceptEdits" || arg === "auto") {
              if (session.mode === "plan") session.mode = "normal";
              permModeOverride = arg as PermissionMode;
              return { handled: true, output: arg === "acceptEdits" ? "✎ acceptEdits:自动批准文件编辑,其余照常审批" : arg === "auto" ? "⊙ auto:只读命令/工作区内编辑自动放行;其余交 AI 分类器,确信安全的自动过、拿不准的转人工审批(不会替你拒绝);deny 规则/敏感目标仍按规则拦。" : "权限模式已设为 default(按需审批)" };
            }
            return { handled: true, output: `未知模式:${arg}(可选 default/acceptEdits/auto/plan)` };
          }
          if (name === "goal" || name === "task") { // task 为旧别名
            const arg = line.trim().slice(1).split(/\s+/).slice(1).join(" ").trim();
            if (arg) {
              // /goal <目标>:确保长任务模式已开,并立即把目标当作一个回合跑(不丢 prompt)。
              if (!longTask) {
                longTask = true;
                // 自主模式用 auto(AI 判定自动批准),而非 yolo 全开——更安全;yolo 只能 --yolo 启动。
                if (!yolo && session.mode !== "plan") permModeOverride = "auto";
                session.messages.push({ role: "system", content: LONG_TASK_DIRECTIVE });
              }
              return { handled: true, prompt: arg };
            }
            // 无参数:沿用开关语义。
            longTask = !longTask;
            if (longTask) {
              if (!yolo && session.mode !== "plan") permModeOverride = "auto";
              session.messages.push({ role: "system", content: LONG_TASK_DIRECTIVE });
              return { handled: true, output: "∞ 长任务自主模式已开启:auto 自动批准(AI 判定)+ 自主连续推进 + 更高轮数;直接 /goal <目标> 或说出要做的长任务即可。" };
            }
            if (!yolo) permModeOverride = null;
            return { handled: true, output: "长任务模式已关闭(权限模式恢复 default)。" };
          }
          if (name === "coordinator") {
            // Coordinator 已并入长任务自主模式(阶段化编排现写在 LONG_TASK_DIRECTIVE 里)。保留为别名:开启长任务。
            if (!longTask) {
              longTask = true;
              if (!yolo && session.mode !== "plan") permModeOverride = "auto";
              session.messages.push({ role: "system", content: LONG_TASK_DIRECTIVE });
            }
            return { handled: true, output: "❖ Coordinator 已并入长任务自主模式:已开启(auto 自动批准 + 自主推进 + 任务大时自动按研究→综合→实现→验证分阶段)。直接说出要做的较大任务即可。" };
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
            ckpt.snapshot("回退前自动快照"); // 先存当前状态,使回退本身可逆(防丢未快照的手动改动)
            const ok = ckpt.restore(target.ref);
            return { handled: true, output: ok ? `已回退工作区到检查点:${target.label}(回退前状态已存为"回退前自动快照",可再 /restore 找回)` : "回退失败" };
          }
          // 通用技能手动调用(对齐 CC 的 /skill-name):/<slug> → 把 user-invocable 技能正文当 prompt 跑一回合。
          // 放在最后(已知命令之后);排除保留命令名,避免遮蔽。
          if (name && !["model", "clear", "compact", "cost", "help", "exit"].includes(name)) {
            const sk = findUserInvocableSkill(skills, name);
            if (sk) return { handled: true, prompt: sk.body };
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
          costCNY: session.costCNY(),
          yolo,
          longTask,
          branch: gitBranch,
          contextPct: (contextTokens() / CONTEXT_WINDOW) * 100,
        }),
        cycleMode: () => {
          // yolo(bypassPermissions)不在 Shift+Tab 循环里——只能 `dao --yolo` 启动时开启。
          // 若当前正处于 yolo,Shift+Tab 退出到 default(可降权,不可在循环中升到 yolo)。
          // acceptEdits(自动接受编辑)不在循环里——仍可用 /mode acceptEdits 显式进入,但不参与 Shift+Tab 轮换。
          const order: PermissionMode[] = ["default", "auto", "plan"];
          const cur = getMode();
          // 当前若在 acceptEdits(经 /mode 进入,不在循环里),Shift+Tab 视为从头进 default 的下一个。
          const idx = order.indexOf(cur);
          const next = cur === "bypassPermissions" ? "default" : order[(idx + 1) % order.length]!;
          yolo = false; // 循环永不进入 yolo
          session.mode = next === "plan" ? "plan" : "normal";
          permModeOverride = next;
          return next;
        },
        register: ({ approvalPrompt, askUser, askChoice }) => {
          inkApprovalPrompt = approvalPrompt;
          inkAsk = askUser;
          inkAskChoice = askChoice;
        },
        completeFiles: (prefix) =>
          (prefix ? fileCache.filter((f) => f.includes(prefix)) : fileCache).slice(0, 8),
        listResume: () =>
          listSessions(sessionsDir).map((m) => ({
            id: m.id,
            label: `${m.id}${m.title ? ` — ${m.title}` : ""}${m.done ? "" : " ·未完成"}`,
          })),
        initialItems,
        drainNotifications: () => taskManager.drainNotifications(),
        subscribeTasks: (cb) => taskManager.onChange(cb),
        runningTasks: () => taskManager.running().length,
        listAccounts,
        switchAccount: (n) => { switchAccount(n); },
        removeAccount,
        addAccount,
        listSkills,
        setSkillEnabled,
        batchSkills,
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
      await injectSessionStart(); // SessionStart 注入(首回合前)
      await runRepl({ session, readLine, runTurn: runOneTurn, write, compact: runCompaction, gateUserPrompt, drainNotifications: () => taskManager.drainNotifications(), onUserMessage: (text) => { void replyChallenge.onUserMessage(text); } });
      await runHooks(hooks, "SessionEnd", { cwd: workspaceRoot }); // 会话结束钩子(与 TTY 分支对齐)
      await mcp.close();
    }
    if (session.usage.promptTokens > 0) write(`\n${session.usageSummary()}\n`);
    if (exitSessionId) write(`会话 ${exitSessionId} · 续写:dao -c(最近一个)或启动后 /resume ${exitSessionId}\n`);
    // 退出【不再】蒸馏:记忆已在各热回合边界增量捕获;退出时缓存已凉,全量蒸只会撞冷缓存全价。
  } finally {
    closeRl();
  }
}

// 收尾后显式退出:distill 的 flash HTTP keep-alive socket 等滞留 handle 会让 Node 排不空事件循环、
// 不自然退出(看起来卡在"✓ 记忆无需更新"那行)。要紧的 await(distill/upsert/mcp.close)都已在 main 内完成。
main().then(
  () => process.exit(0),
  (err) => {
    console.error("\n" + (err as Error).message);
    process.exit(1);
  },
);
