import { z } from "zod";
import { defineTool } from "./types.js";
import { processManager } from "./process_manager.js";
import { msg } from "./lang.js";

export const execShellPollTool = defineTool({
  name: "BashOutput",
  description: "读取某个后台进程(Bash 的 background=true 启动的)自上次轮询以来的【新增】输出与当前状态" +
    "(running/exited)。后台进程完成时会自动通知你,不需要反复轮询--这里只用于查看中间输出(进度/报错)。" +
    "每次调用都会清空已读部分--不会重复看到同一段输出,但也意味着漏轮询的这段时间的输出拿不回来了" +
    "(status 会告诉你 exited,配合 exitCode/signal 一起看)。典型场景:后台起了个跑很久的构建/测试命令," +
    "过一会儿轮一次看看有没有报错或跑到哪了,而不是干等在原地--进程跑完会自动通知,你不用盯着。stdout/stderr 分开展示,报错信息" +
    "混在 stderr 里、别只看 stdout 就以为没问题;exited 后依然可以再轮一次拿最后一点残留输出,但只能拿这一次," +
    "之后这个 id 就没有新内容了。",
  descriptionEn: "Reads [new] output from a background process (started via Bash's background=true) since the last poll, and its current status " +
    "(running/exited). You'll be automatically notified when the process finishes - don't poll for completion; use this only to check intermediate output (progress/errors). " +
    "Each call clears what's been read - you won't see the same output twice, but it also means output from a gap you didn't poll during " +
    "is gone for good (status will still tell you it exited, along with exitCode/signal). Typical use: you " +
    "started a long-running build/test command in the background, and come back to poll once to check for errors or progress " +
    "rather than sitting idle waiting - the process will notify you when done, you don't need to watch it. stdout and stderr are shown separately - error output lives in stderr, don't assume things are fine just because stdout looks clean; " +
    "you can still poll once more right after it exits to catch any trailing output, but only once - there's nothing new to get after that.",
  capability: "read",
  approval: "auto",
  schema: z.object({
    id: z.string().describe("Bash 返回的后台进程 id"),
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
