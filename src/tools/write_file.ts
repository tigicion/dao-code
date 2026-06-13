import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool } from "./types.js";
import { resolveWritePath } from "./paths.js";
import { atomicWrite } from "./fs_atomic.js";
import { withFileLock } from "./file_lock.js";

export const writeFileTool = defineTool({
  name: "write_file",
  description: "在工作区内新建或整体重写一个文件。覆盖已存在文件前必须先用 read_file 读过它。",
  capability: "write",
  approval: "required",
  schema: z.object({
    path: z.string().describe("相对工作区根目录的文件路径"),
    content: z.string().describe("文件的完整内容"),
  }),
  handler: async (args, ctx) => {
    const abs = resolveWritePath(ctx.workspaceRoot, args.path);
    // 同路径持锁:与并行的 edit/write 同文件排队,避免互相覆盖。
    return withFileLock(abs, async () => {
      let exists = false;
      try {
        await fs.access(abs);
        exists = true;
      } catch {
        exists = false;
      }
      if (exists && ctx.readFiles && !ctx.readFiles.has(abs)) {
        throw new Error(`覆盖已存在文件前请先用 read_file 读过它:${args.path}`);
      }
      await atomicWrite(abs, args.content);
      ctx.readFiles?.add(abs);
      return `已写入 ${args.path}(${args.content.split("\n").length} 行)`;
    });
  },
});
