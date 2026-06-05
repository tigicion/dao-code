import { loadConfig } from "./config/config.js";
import { streamChat } from "./client/client.js";
import { runAgent } from "./agent/loop.js";
import { executeToolCalls } from "./tools/execute.js";
import { ToolRegistry } from "./tools/registry.js";
import { readFileTool } from "./tools/read_file.js";
import { listDirTool } from "./tools/list_dir.js";

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

  const registry = new ToolRegistry();
  registry.register(readFileTool);
  registry.register(listDirTool);

  await runAgent({
    prompt,
    config: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model },
    registry,
    ctx: { workspaceRoot: process.cwd() },
    streamChat,
    executeToolCalls,
    write: (s) => process.stdout.write(s),
  });
}

main().catch((err) => {
  console.error("\n" + (err as Error).message);
  process.exit(1);
});
