import { z } from "zod";
import { defineTool } from "./types.js";
import { processManager } from "./process_manager.js";
import { msg } from "./lang.js";

export const execShellPollTool = defineTool({
  name: "exec_shell_poll",
  description: "读取某个后台进程自上次轮询以来的新输出与当前状态(running/exited)。",
  descriptionEn: "Reads new output from a background process since the last poll, and its current status (running/exited).",
  capability: "read",
  approval: "auto",
  schema: z.object({
    id: z.string().describe("exec_shell 返回的后台进程 id"),
  }),
  handler: async (args) => {
    const r = processManager.poll(args.id);
    const parts: string[] = [msg(`状态:${r.status}`, `Status: ${r.status}`)];
    if (r.stdout.trim()) parts.push(r.stdout.trimEnd());
    if (r.stderr.trim()) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
    if (r.status === "exited") {
      parts.push(`[exit ${r.exitCode ?? ""}${r.signal ? ` signal ${r.signal}` : ""}]`);
    }
    return parts.join("\n");
  },
});
