import { z } from "zod";
import { defineTool } from "./types.js";
import { processManager } from "./process_manager.js";

export const execShellKillTool = defineTool({
  name: "exec_shell_kill",
  description: "终止某个后台进程(发送 SIGTERM)。",
  capability: "exec",
  approval: "auto",
  schema: z.object({
    id: z.string().describe("exec_shell 返回的后台进程 id"),
  }),
  handler: async (args) => {
    processManager.kill(args.id);
    return `已发送终止信号给 ${args.id}`;
  },
});
