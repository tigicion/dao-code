import { z } from "zod";
import { defineTool } from "./types.js";
import { processManager } from "./process_manager.js";
import { msg } from "./lang.js";

export const execShellKillTool = defineTool({
  name: "exec_shell_kill",
  description: "终止某个后台进程(exec_shell 的 background=true 启动的)——杀的是整个进程组(SIGTERM)," +
    "命令自己再拉起的子进程也会一起终止,不会留下孤儿进程。approval 是 auto:语义是清理一个你自己已经批准过" +
    "在跑的后台任务,不是发起新的有风险动作,不需要再确认一遍。杀掉之后如果再 exec_shell_poll 这个 id,状态会显示" +
    "已退出,但杀掉之前那段没轮询到的输出还是拿不回来。典型场景:后台起了个开发服务器/watch 进程,任务做完了要收尾," +
    "或者中途发现起错了命令,用这个把它结束掉,别让它一直占着端口/进程空跑。杀掉一个不存在/早已退出的 id 不会报错," +
    "只是提示信号已发送,自行用 exec_shell_poll 确认真实状态。",
  descriptionEn: "Terminates a background process (started via exec_shell's background=true) — kills the entire process group (SIGTERM), " +
    "so any child processes the command spawned are terminated too, no orphans left behind. approval is auto: the semantics are cleaning up a " +
    "background task you already approved earlier, not initiating a new risky action, so no extra confirmation is needed. After killing, polling " +
    "the same id with exec_shell_poll will show it as exited, but output from before the kill that was never polled is still unrecoverable. Typical use: " +
    "you started a dev server/watch process in the background and the task is wrapping up, or you realize mid-way you started the wrong command — kill it " +
    "rather than leaving it occupying a port or running idle. Killing a nonexistent or already-exited id doesn't error — it just reports the signal was sent; " +
    "confirm the actual state yourself via exec_shell_poll.",
  capability: "exec",
  approval: "auto",
  schema: z.object({
    id: z.string().describe("exec_shell 返回的后台进程 id"),
  }),
  handler: async (args) => {
    processManager.kill(args.id);
    return msg(`已发送终止信号给 ${args.id}`, `Sent termination signal to ${args.id}`);
  },
});
