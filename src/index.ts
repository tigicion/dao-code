import path from "node:path";
import { loadConfig } from "./config/config.js";
import { streamChat } from "./client/client.js";
import { runAgent } from "./agent/loop.js";
import { executeToolCalls } from "./tools/execute.js";
import { ToolRegistry } from "./tools/registry.js";
import { readFileTool } from "./tools/read_file.js";
import { listDirTool } from "./tools/list_dir.js";
import { writeFileTool } from "./tools/write_file.js";
import { editFileTool } from "./tools/edit_file.js";
import { execShellTool } from "./tools/exec_shell.js";
import { execShellPollTool } from "./tools/exec_shell_poll.js";
import { execShellKillTool } from "./tools/exec_shell_kill.js";
import { SessionApprovalGate } from "./approval/gate.js";
import { stdinApprovalPrompt } from "./approval/stdin_prompt.js";
import { loadAlwaysApproved, appendAlwaysApproved } from "./approval/store.js";

async function main() {
  const prompt = process.argv.slice(2).join(" ").trim();
  if (!prompt) {
    console.error('用法: npm run dev -- "你的问题"');
    process.exit(1);
  }

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
  registry.register(readFileTool);
  registry.register(listDirTool);
  registry.register(writeFileTool);
  registry.register(editFileTool);
  registry.register(execShellTool);
  registry.register(execShellPollTool);
  registry.register(execShellKillTool);

  const alwaysApproved = await loadAlwaysApproved(approvalsFile);
  const gate = new SessionApprovalGate(stdinApprovalPrompt, alwaysApproved, (name) =>
    appendAlwaysApproved(approvalsFile, name),
  );

  await runAgent({
    prompt,
    config: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model },
    registry,
    ctx: { workspaceRoot, readFiles: new Set<string>() },
    gate,
    streamChat,
    executeToolCalls,
    write: (s) => process.stdout.write(s),
  });
}

main().catch((err) => {
  console.error("\n" + (err as Error).message);
  process.exit(1);
});
