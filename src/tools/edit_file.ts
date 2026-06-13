import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool } from "./types.js";
import { resolveWritePath } from "./paths.js";
import { atomicWrite } from "./fs_atomic.js";
import { buildEditHunk } from "./diff_hunk.js";
import { withFileLock } from "./file_lock.js";

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
    const abs = await resolveWritePath(ctx.workspaceRoot, args.path, ctx.approveExternalWrite);
    // 同路径"读-改-写"全程持锁:并行编辑同一文件时排队,杜绝丢改动 / 撞临时文件。
    return withFileLock(abs, async () => {
      if (ctx.readFiles && !ctx.readFiles.has(abs)) {
        throw new Error(`编辑前请先用 read_file 读过它:${args.path}`);
      }
      const raw = await fs.readFile(abs, "utf8");
      const count = raw.split(args.old_string).length - 1;
      if (count === 0) throw new Error(`未找到 old_string:${args.path}`);
      if (count > 1 && !args.replace_all) {
        throw new Error(`old_string 在 ${args.path} 出现 ${count} 次,不唯一;用 replace_all 或扩大上下文`);
      }
      // split/join 对单处(count===1)与全部替换都正确,且不会把 new_string 里的 $ 当成替换模式。
      const next = raw.split(args.old_string).join(args.new_string);
      await atomicWrite(abs, next);
      // 首处匹配所在行号(1-based),供 TUI 给 diff 标行号(对标 CC)。
      const startLine = raw.slice(0, raw.indexOf(args.old_string)).split("\n").length;
      // 带行号+上下文的 diff hunk(```diff 块):模型可读、TUI 据此渲染(复刻 CC)。
      const hunk = buildEditHunk(raw, args.old_string, args.new_string);
      const diffBlock = hunk.length ? `\n\`\`\`diff\n${hunk.join("\n")}\n\`\`\`` : "";
      return `已编辑 ${args.path}(替换 ${args.replace_all ? count : 1} 处,行 ${startLine})${diffBlock}`;
    });
  },
});
