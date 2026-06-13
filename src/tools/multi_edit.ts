import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool } from "./types.js";
import { resolveWritePath } from "./paths.js";
import { atomicWrite } from "./fs_atomic.js";
import { withFileLock } from "./file_lock.js";

// 对一个文件按顺序应用多处精确替换,原子(全部成功才写盘,任一处失败则整体不动)。对标 CC 的 MultiEdit。
export const multiEditTool = defineTool({
  name: "multi_edit",
  description:
    "对工作区内一个文件按顺序应用多处精确字符串替换;原子操作——任一处失败则整体不写盘。编辑前需先用 read_file 读过它。每处 old_string 须在【施加该处时的内容】中唯一(或设 replace_all)。比连发多个 edit_file 更安全:要么全成、要么全不改。",
  capability: "write",
  approval: "required",
  schema: z.object({
    path: z.string().describe("相对工作区根的文件路径"),
    edits: z
      .array(
        z.object({
          old_string: z.string().describe("要被替换的原文"),
          new_string: z.string().describe("替换成的新文本"),
          replace_all: z.boolean().optional().describe("是否替换全部出现"),
        }),
      )
      .min(1)
      .describe("按顺序应用的替换列表"),
  }),
  handler: async (args, ctx) => {
    const abs = resolveWritePath(ctx.workspaceRoot, args.path);
    return withFileLock(abs, async () => {
      if (ctx.readFiles && !ctx.readFiles.has(abs)) {
        throw new Error(`编辑前请先用 read_file 读过它:${args.path}`);
      }
      let text = await fs.readFile(abs, "utf8");
      let total = 0;
      // 先全部校验+施加到内存,全部通过才落盘(原子)。
      for (let i = 0; i < args.edits.length; i++) {
        const e = args.edits[i]!;
        const count = text.split(e.old_string).length - 1;
        if (count === 0) throw new Error(`第 ${i + 1} 处未找到 old_string(整体未改):${e.old_string.slice(0, 40)}`);
        if (count > 1 && !e.replace_all) {
          throw new Error(`第 ${i + 1} 处 old_string 出现 ${count} 次、不唯一;用 replace_all 或扩大上下文(整体未改)`);
        }
        text = text.split(e.old_string).join(e.new_string);
        total += e.replace_all ? count : 1;
      }
      await atomicWrite(abs, text);
      return `已编辑 ${args.path}(${args.edits.length} 组替换,共 ${total} 处)`;
    });
  },
});
