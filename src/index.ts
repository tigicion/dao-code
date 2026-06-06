import { createInterface } from "node:readline/promises";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "./config/config.js";
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
import { loadAllMemories } from "./memory/store.js";
import { SessionApprovalGate } from "./approval/gate.js";
import { makeApprovalPrompt } from "./approval/stdin_prompt.js";
import { loadAlwaysApproved, appendAlwaysApproved } from "./approval/store.js";
import { buildSystemPrompt } from "./prompt/system_prompt.js";
import { Session } from "./session/session.js";
import { runRepl } from "./repl.js";

async function main() {
  const argvPrompt = process.argv.slice(2).join(" ").trim();

  let cfg;
  try {
    cfg = loadConfig(process.env);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const workspaceRoot = process.cwd();
  const approvalsFile = path.join(workspaceRoot, ".codeds", "approvals.json");

  const registry = new ToolRegistry();
  for (const t of [
    readFileTool, listDirTool, writeFileTool, editFileTool,
    execShellTool, execShellPollTool, execShellKillTool,
    grepFilesTool, fileSearchTool, askUserTool, fetchUrlTool, webSearchTool, todoWriteTool, memoryWriteTool,
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

  const write = (s: string) => process.stdout.write(s);

  // 单一 readline:'line' 事件喂一个共享行队列;REPL 读行与审批/ask_user 都从这一个
  // nextLine() 拉,保证管道里的行按 FIFO 分配,不会出现两个消费者抢 stdin。
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
  // ask:打印提示,从共享队列拉下一行(EOF → 空串)。审批 / ctx.ask 共用。
  const ask = async (prompt: string): Promise<string> => {
    write(prompt);
    const line = await nextLine();
    return line ?? "";
  };

  const alwaysApproved = await loadAlwaysApproved(approvalsFile);
  const gate = new SessionApprovalGate(makeApprovalPrompt(ask), alwaysApproved, (name) =>
    appendAlwaysApproved(approvalsFile, name),
  );

  const session = new Session(systemPrompt, cfg.model);
  const ctx = {
    workspaceRoot,
    readFiles: new Set<string>(),
    ask: (q: string) => ask(`\n${q}\n> `),
    fetchImpl: fetch,
  };

  const runOneTurn = () =>
    runTurn({
      session,
      config: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey },
      registry,
      ctx,
      gate,
      streamChat,
      executeToolCalls,
      write,
    });

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
    await runRepl({ session, readLine, runTurn: runOneTurn, write });
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error("\n" + (err as Error).message);
  process.exit(1);
});
