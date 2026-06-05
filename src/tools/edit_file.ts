import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool } from "./types.js";
import { resolveInWorkspace } from "./paths.js";

export const editFileTool = defineTool({
  name: "edit_file",
  description:
    "对工作区内已存在文件做精确字符串替换。old_string 必须在文件中唯一(否则用 replace_all 或扩大上下文)。编辑前需先用 read_file 读过它。",
  capability: "write",
  approval: "required",
  schema: z.object({
    path: z.string().describe("相对工作区根目录的文件路径"),
    old_string: z.string().describe("要被替换的原文(需唯一)"),
    new_string: z.string().describe("替换成的新文本"),
    replace_all: z.boolean().optional().describe("是否替换全部出现"),
  }),
  handler: async (args, ctx) => {
    const abs = resolveInWorkspace(ctx.workspaceRoot, args.path);
    if (ctx.readFiles && !ctx.readFiles.has(abs)) {
      throw new Error(`编辑前请先用 read_file 读过它:${args.path}`);
    }
    const raw = await fs.readFile(abs, "utf8");
    const count = raw.split(args.old_string).length - 1;
    if (count === 0) throw new Error(`未找到 old_string:${args.path}`);
    if (count > 1 && !args.replace_all) {
      throw new Error(`old_string 在 ${args.path} 出现 ${count} 次,不唯一;用 replace_all 或扩大上下文`);
    }
    const next = args.replace_all
      ? raw.split(args.old_string).join(args.new_string)
      : raw.replace(args.old_string, args.new_string);
    await fs.writeFile(abs, next, "utf8");
    return `已编辑 ${args.path}(替换 ${args.replace_all ? count : 1} 处)`;
  },
});
