import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool } from "./types.js";
import { resolveInWorkspace } from "./paths.js";
import { atomicWrite } from "./fs_atomic.js";

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
    const abs = resolveInWorkspace(ctx.workspaceRoot, args.path);
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
  },
});
