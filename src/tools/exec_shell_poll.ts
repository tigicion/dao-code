import { z } from "zod";
import { defineTool } from "./types.js";
import { processManager } from "./process_manager.js";
import { msg } from "./lang.js";

export const execShellPollTool = defineTool({
  name: "exec_shell_poll",
  description: "读取某个后台进程(exec_shell 的 background=true 启动的)自上次轮询以来的【新增】输出与当前状态" +
    "(running/exited)。每次调用都会清空已读部分——不会重复看到同一段输出,但也意味着漏轮询的这段时间的输出" +
    "拿不回来了(status 会告诉你 exited,配合 exitCode/signal 一起看)。想等它跑完再看全部输出,自己按需隔一段轮一次," +
    "别一直连续调用空转——进程是异步跑的,不轮询它不会更快结束。典型场景:后台起了个跑很久的构建/测试命令," +
    "先去做别的事,过一会儿回来轮一次看看有没有报错或跑完,而不是干等在原地。stdout/stderr 分开展示,报错信息" +
    "混在 stderr 里、别只看 stdout 就以为没问题;exited 后依然可以再轮一次拿最后一点残留输出,但只能拿这一次," +
    "之后这个 id 就没有新内容了。",
  descriptionEn: "Reads [new] output from a background process (started via exec_shell's background=true) since the last poll, and its current status " +
    "(running/exited). Each call clears what's been read — you won't see the same output twice, but it also means output from a gap you didn't poll during " +
    "is gone for good (status will still tell you it exited, along with exitCode/signal). To see the full output once it's done, poll at reasonable " +
    "intervals as needed — don't spin-poll continuously; the process runs asynchronously and polling it doesn't make it finish any faster. Typical use: you " +
    "started a long-running build/test command in the background, went off to do something else, and come back to poll once to check for errors or completion " +
    "rather than sitting idle waiting. stdout and stderr are shown separately — error output lives in stderr, don't assume things are fine just because stdout looks clean; " +
    "you can still poll once more right after it exits to catch any trailing output, but only once — there's nothing new to get after that.",
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
