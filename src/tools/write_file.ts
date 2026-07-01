import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool } from "./types.js";
import { resolveWritePath } from "./paths.js";
import { atomicWrite } from "./fs_atomic.js";
import { withFileLock } from "./file_lock.js";
import { msg } from "./lang.js";

export const writeFileTool = defineTool({
  name: "write_file",
  description: "在工作区内新建或整体重写一个文件。覆盖已存在文件前必须先用 read_file 读过它。",
  descriptionEn: "Creates or overwrites a file in the workspace. Must read_file existing files before overwriting.",
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
      // P2-23 mtime/size 复核:文件自上次 read 后被外部改动 → 拒绝(防整体重写覆盖用户/外部的并发编辑)。
      if (exists) {
        const meta = ctx.readMeta?.get(abs);
        if (meta) {
          const cur = await fs.stat(abs);
          if (cur.mtimeMs !== meta.mtime || cur.size !== meta.size) {
            throw new Error(`文件自上次 read_file 后已被外部改动:${args.path}。请重新 read_file 看最新内容再写,以免覆盖他人改动。`);
          }
        }
      }
      await atomicWrite(abs, args.content);
      try { const w = await fs.stat(abs); ctx.readMeta?.set(abs, { mtime: w.mtimeMs, size: w.size }); } catch { /* ignore */ } // 写后刷新基线
      ctx.readFiles?.add(abs);
      return msg(`已写入 ${args.path}(${args.content.split("\n").length} 行)`, `Wrote ${args.path} (${args.content.split("\n").length} lines)`);
    });
  },
});
