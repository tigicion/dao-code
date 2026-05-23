#!/usr/bin/env node
import { createInterface, type Interface } from "node:readline/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { readConfig } from "./config/config.js";
import { loadDotenv } from "./config/env_file.js";
import { loadStoredKey, saveKey } from "./config/key_store.js";
import { streamChat } from "./client/client.js";
import { runTurn } from "./agent/loop.js";
import { executeToolCalls } from "./tools/execute.js";
import { ToolRegistry } from "./tools/registry.js";
import { readFileTool } from "./tools/read_file.js";
import { listDirTool } from "./tools/list_dir.js";
import { writeFileTool } from "./tools/write_file.js";
import { editFileTool } from "./tools/edit_file.js";
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
import { runSubagent } from "./agent/subagent.js";
import { agentTool } from "./tools/agent.js";
import { loadAllMemories, upsertMemory, migrateLegacy } from "./memory/store.js";
import { validateMemory, type Verdict } from "./memory/validate.js";
import { buildMemorySection, selectForInjection } from "./memory/inject.js";
import { gcMemories } from "./memory/gc.js";
import { distill } from "./memory/distill.js";
import { makeFlashAdjudicator } from "./memory/adjudicate.js";
import { SessionApprovalGate } from "./approval/gate.js";
import type { ApprovalGate } from "./approval/types.js";
import { makeApprovalPrompt } from "./approval/stdin_prompt.js";
import { loadAlwaysApproved, appendAlwaysApproved } from "./approval/store.js";
import { buildSystemPrompt } from "./prompt/system_prompt.js";
import { Session } from "./session/session.js";
import { runRepl } from "./repl.js";
import { dispatchCommand } from "./commands/commands.js";
import { buildWelcome } from "./tui/banner.js";
import { detectCapabilities } from "./tui/capabilities.js";
import { bgFromEnv } from "./tui/background.js";
import { randomMaxim } from "./tui/maxim.js";
import { runInkApp } from "./tui/app/run.js";
import type { ApprovalPrompt } from "./approval/types.js";
import { VERSION } from "./version.js";
import { compactMessages, shouldCompact } from "./agent/compact.js";
import type { ChatMessage } from "./client/types.js";
import type { ToolContext } from "./tools/types.js";

const KEY_HELP =
  "获取 key:https://platform.deepseek.com/api_keys";

async function main() {
  const argvPrompt = process.argv.slice(2).join(" ").trim();
  const workspaceRoot = process.cwd();
  const approvalsFile = path.join(workspaceRoot, ".codeds", "approvals.json");
  const keyFile = path.join(os.homedir(), ".codeds", "config.json");

  const write = (s: string) => process.stdout.write(s);

  // 背景(亮/暗):用 env 线索(DAO_THEME / COLORFGBG),默认 dark。
  // (OSC 11 主动探测会与 readline/Ink 抢 stdin,暂不在启动路径用;可 export DAO_THEME=light 强制。)
  const bg = bgFromEnv(process.env) ?? "dark";

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
    readFileTool, listDirTool, writeFileTool, editFileTool,
    execShellTool, execShellPollTool, execShellKillTool,
    grepFilesTool, fileSearchTool, askUserTool, fetchUrlTool, webSearchTool, todoWriteTool, memoryWriteTool, agentTool,
  ]) {
    registry.register(t);
  }

  const toolSummaries = registry
    .toApiTools()
    .map((t) => `- ${t.function.name}:${t.function.description}`)
    .join("\n");

  // ---- 记忆读路径(会话启动一次性):迁移旧 JSON → 加载 → 确定性权威验证 → 注入固定前缀 ----
  const projectMemoryDir = path.join(workspaceRoot, ".codeds", "memory");
  const userMemoryDir = path.join(os.homedir(), ".codeds", "memory");
  const today = new Date().toISOString().slice(0, 10);
  // 一次性把旧 memories.json 迁移成 md(已迁移则跳过;目录不存在也容错)。
  await migrateLegacy(projectMemoryDir, today);
  await migrateLegacy(userMemoryDir, today);
  // 衰减 GC:先剪掉死记忆(留存跌破阈值的低价值事实 / 过期且宽限期已过的取代项),
  // 使它们既不被加载也不被注入。确定性,无 LLM。
  await gcMemories(projectMemoryDir, today);
  await gcMemories(userMemoryDir, today);
  const memories = await loadAllMemories(projectMemoryDir, userMemoryDir);
  // 逐条对照 live code 做确定性验证(stale 剔除 / changed 标注 / ok 注入)。
  const validated: { mem: (typeof memories)[number]; verdict: Verdict }[] = [];
  for (const mem of memories) {
    const { verdict } = await validateMemory(mem, workspaceRoot, today);
    validated.push({ mem, verdict });
  }
  // store 过大时按 top-K 封顶注入(user 模型必留);会话启动无 query,确定性选择。
  const memoryText = buildMemorySection(selectForInjection(validated, today));

  const systemPrompt = buildSystemPrompt({
    modelId: cfg.model,
    toolSummaries,
    memories: memoryText,
    cwd: workspaceRoot,
    platform: process.platform,
  });

  // Ink 交互态注册的审批/提问模态(App 挂载后填入);未填则回退 readline。
  let inkApprovalPrompt: ApprovalPrompt | null = null;
  let inkAsk: ((q: string) => Promise<string>) | null = null;

  // CODEDS_AUTO_APPROVE=1 时跳过所有审批(用于 eval / CI 在抛弃式工作区里无人值守运行)。
  const alwaysApproved = await loadAlwaysApproved(approvalsFile);
  const readlinePrompt = makeApprovalPrompt(ask);
  const gate: ApprovalGate = process.env.CODEDS_AUTO_APPROVE
    ? { needsApproval: () => false, requestBatch: async () => new Map() }
    : new SessionApprovalGate(
        (reqs) => (inkApprovalPrompt ?? readlinePrompt)(reqs), // Ink 态用模态,否则 readline
        alwaysApproved,
        (name) => appendAlwaysApproved(approvalsFile, name),
      );

  const session = new Session(systemPrompt, cfg.model);
  const ctx: ToolContext = {
    workspaceRoot,
    readFiles: new Set<string>(),
    ask: (q: string) => (inkAsk ? inkAsk(q) : ask(`\n${q}\n> `)),
    fetchImpl: fetch,
    today,
  };

  // 子代理的直接输出在 Ink 态需静默(否则 write 到 stdout 会冲掉 Ink 渲染;其最终结果仍作工具结果展示)。
  let subagentWrite: (s: string) => void = write;
  ctx.runSubagent = (task: string) =>
    runSubagent({
      task,
      systemPrompt,
      model: session.model,
      mode: session.mode,
      config: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey },
      registry,
      ctx,
      gate,
      streamChat,
      executeToolCalls,
      write: subagentWrite,
      runTurn,
    });

  const KEEP_RECENT_TURNS = 2;
  const CONTEXT_WINDOW = 1_000_000;

  // 压缩用:对一批旧消息生成简洁摘要(独立一次 streamChat,不带工具,不流式渲染)。
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
        { role: "system", content: "你是对话压缩器。把给定的早期对话压缩成简洁中文摘要,保留:关键事实与用户偏好、已做的文件改动与命令、做出的决定、未完成事项。只输出摘要正文,不要寒暄。" },
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
    return out.trim() || (typeof r.value.content === "string" ? r.value.content : "(摘要为空)");
  };

  const runCompaction = async (): Promise<void> => {
    const before = session.messages.length;
    session.messages = await compactMessages(session.messages, {
      keepRecentTurns: KEEP_RECENT_TURNS,
      summarize,
    });
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
    session.messages = await compactMessages(session.messages, { keepRecentTurns: KEEP_RECENT_TURNS, summarize });
  };

  // 会话结束蒸馏:独立一次 flash + 关思考(distill 内部已设)抽取原子事实/用户模型,
  // 去重后 upsert 到项目记忆。全程 try/catch,失败绝不阻塞退出。仅当有 ≥1 轮真实用户对话时触发。
  const distillOnExit = async (): Promise<void> => {
    const hasRealTurn = session.messages.some((m) => m.role === "user");
    if (!hasRealTurn) return;
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
        const existing = await loadAllMemories(projectMemoryDir, userMemoryDir);
        await upsertMemory(projectMemoryDir, cand, existing, adjudicate);
        n++;
      }
      if (n > 0) write(`\n已更新记忆:${n} 条\n`);
    } catch (e) {
      if (process.env.CODEDS_DEBUG_MEMORY) console.error("[distill] 蒸馏失败:", e);
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
      thinking: process.env.CODEDS_REASONING_EFFORT || "max",
      cwd: workspaceRoot,
      version: VERSION,
      branch: gitBranch,
    };

    if (process.stdout.isTTY) {
      // 交互态:Ink REPL(inline)。常见路径下从未创建 readline(stdin 干净),Ink 的 useInput 直接接管;
      // 仅当首次运行做过 key 引导才存在 rl,此时关掉让出 stdin。
      subagentWrite = () => {}; // Ink 态静默子代理直接输出
      closeRl();
      await runInkApp({
        welcome: { info: welcomeInfo, caps, bg, maxim: randomMaxim() },
        submit: async (text, { events, signal }) => {
          session.addUser(text);
          await runTurn({
            session,
            config: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey },
            registry,
            ctx,
            gate,
            streamChat,
            executeToolCalls,
            write: () => {},
            events,
            signal,
          });
          if (shouldCompact(session.messages, CONTEXT_WINDOW)) {
            events.notice("[接近上限,自动压缩…]");
            await inkCompact();
          }
        },
        runCommand: (line) => dispatchCommand(line, session),
        compact: inkCompact,
        getStatus: () => ({
          model: session.model,
          mode: session.mode,
          promptTokens: session.usage.promptTokens,
          completionTokens: session.usage.completionTokens,
          cacheHitRatio: session.cacheHitRatio(),
        }),
        register: ({ approvalPrompt, askUser }) => {
          inkApprovalPrompt = approvalPrompt;
          inkAsk = askUser;
        },
      });
    } else {
      // 非交互(管道/CI/eval):纯文本 banner + readline REPL,行为不变。
      write(buildWelcome(welcomeInfo, caps, undefined, bg) + "\n");
      const readLine = async (): Promise<string | null> => {
        write("\n> ");
        return nextLine();
      };
      await runRepl({ session, readLine, runTurn: runOneTurn, write, compact: runCompaction });
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
