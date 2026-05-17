import { createInterface } from "node:readline/promises";
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
import { loadAllMemories } from "./memory/store.js";
import { SessionApprovalGate } from "./approval/gate.js";
import { makeApprovalPrompt } from "./approval/stdin_prompt.js";
import { loadAlwaysApproved, appendAlwaysApproved } from "./approval/store.js";
import { buildSystemPrompt } from "./prompt/system_prompt.js";
import { Session } from "./session/session.js";
import { runRepl } from "./repl.js";
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

  // 单一 readline:'line' 事件喂一个共享行队列;REPL 读行 / 审批 / ask_user / key 引导
  // 都从这一个 nextLine() 拉,保证管道里的行按 FIFO 分配,不会两个消费者抢 stdin。
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const lineQueue: string[] = [];
  const lineWaiters: Array<(line: string | null) => void> = [];
  let rlClosed = false;
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
  const nextLine = (): Promise<string | null> => {
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
        rl.close();
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
          "  • 在终端直接运行 codeds(不接管道),会引导你粘贴并保存 key",
          KEY_HELP,
        ].join("\n"),
      );
      rl.close();
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

  const projectMemoryFile = path.join(workspaceRoot, ".codeds", "memory", "memories.json");
  const userMemoryFile = path.join(os.homedir(), ".codeds", "memory", "memories.json");
  const memories = await loadAllMemories(projectMemoryFile, userMemoryFile);
  const memoryText = memories.map((m) => `- ${m.text}`).join("\n");

  const systemPrompt = buildSystemPrompt({ modelId: cfg.model, toolSummaries, memories: memoryText });

  const alwaysApproved = await loadAlwaysApproved(approvalsFile);
  const gate = new SessionApprovalGate(makeApprovalPrompt(ask), alwaysApproved, (name) =>
    appendAlwaysApproved(approvalsFile, name),
  );

  const session = new Session(systemPrompt, cfg.model);
  const ctx: ToolContext = {
    workspaceRoot,
    readFiles: new Set<string>(),
    ask: (q: string) => ask(`\n${q}\n> `),
    fetchImpl: fetch,
  };

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
      write,
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

  try {
    if (argvPrompt) {
      session.addUser(argvPrompt);
      await runOneTurn();
      return;
    }
    write(`codeds —— 输入消息开始;/help 看命令,/exit 退出。\n`);
    const readLine = async (): Promise<string | null> => {
      write("\n> ");
      return nextLine();
    };
    await runRepl({ session, readLine, runTurn: runOneTurn, write, compact: runCompaction });
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error("\n" + (err as Error).message);
  process.exit(1);
});
