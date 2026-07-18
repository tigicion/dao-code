import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "./types.js";

// 对标 CC SendUserMessage:给用户发可见消息(支持 markdown + 文件附件)。
// 与直接输出文本的区别:attachments 可附文件(图片/diff/log);status 标注意图(主动推送 vs 回复)。
export const sendMessageTool = defineTool({
  name: "send_message",
  description:
    "给用户发一条可见消息(支持 markdown)。attachments 可附带文件路径(图片/diff/log 等)。" +
    "status: 'normal'=回复用户刚问的;'proactive'=主动推送(后台任务完成、发现阻塞、未问主动汇报)。" +
    "消息内容支持 GitHub 风格 Markdown 格式。",
  descriptionEn:
    "Send a visible message to the user (supports markdown). attachments takes file paths (images/diffs/logs). " +
    "status: 'normal'=replying to what they asked; 'proactive'=initiating (task done, blocker found, unsolicited update). " +
    "Message supports GitHub-flavored Markdown.",
  capability: "plan",
  approval: "auto",
  schema: z.object({
    message: z.string().describe("要发给用户的消息(支持 markdown)"),
    attachments: z.array(z.string()).optional().describe("要附带的文件路径(绝对或相对工作区根)"),
    status: z.enum(["normal", "proactive"]).describe("'normal'=回复;'proactive'=主动推送"),
  }),
  handler: async (args, ctx) => {
    const parts: string[] = [args.message];

    // 读取附件文件内容(如果可读)
    if (args.attachments && args.attachments.length > 0) {
      for (const p of args.attachments) {
        const abs = path.isAbsolute(p) ? p : path.join(ctx.cwd ?? ctx.workspaceRoot, p);
        try {
          const content = await fs.readFile(abs, "utf8");
          const name = path.basename(p);
          parts.push(`\n---\n附件:${name}\n\`\`\`\n${content.slice(0, 4000)}${content.length > 4000 ? "\n…(已截断)" : ""}\n\`\`\``);
        } catch {
          parts.push(`\n(附件 ${p} 读取失败)`);
        }
      }
    }

    // 主动推送时弹桌面通知
    if (args.status === "proactive" && ctx.notifyUser) {
      ctx.notifyUser(args.message.slice(0, 100));
    }

    return parts.join("\n");
  },
});
