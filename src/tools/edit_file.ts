import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool } from "./types.js";
import { resolveWritePath } from "./paths.js";
import { atomicWrite } from "./fs_atomic.js";
import { buildEditHunk } from "./diff_hunk.js";
import { withFileLock } from "./file_lock.js";
import { msg } from "./lang.js";

export const editFileTool = defineTool({
  name: "Edit",
  description:
    "对工作区内已存在文件做精确字符串替换。old_string 必须在文件中原样(含缩进/空白)唯一出现——不唯一就报错," +
    "报错信息会告诉你出现了几次,此时要么扩大 old_string 的上下文让它变唯一,要么设 replace_all 全部替换,别瞎猜换个词试。" +
    "old_string/new_string 按字面文本替换(不是正则,new_string 里的 $、反斜杠等都当普通字符,不用转义)。" +
    "编辑前需先用 Read 读过它(没读过会直接报错拒绝);复制 old_string 时用 Read 输出里行号后面的原文," +
    "保留其真实缩进——DAO 已有的既定风格优先于你自己的排版偏好,别顺手改格式。\n" +
    "同一文件的并行 Edit 调用会自动排队,不会互相覆盖或撞坏;但同一文件要做多处改动时优先用 MultiEdit" +
    "(一次性提交、原子——要么全成要么全不改),别连发多个 Edit,那样中途某一处失败会留下改了一半的文件。\n" +
    "成功后返回一个 ```diff 代码块和改动首行行号,可以直接读出来确认改对了地方。",
  descriptionEn:
    "Performs exact string replacement in a workspace file. old_string must appear verbatim (including indentation/whitespace) exactly once — otherwise it errors " +
    "(the error tells you how many times it occurred; broaden old_string's context to make it unique, or set replace_all, rather than guessing a different substring). " +
    "old_string/new_string are literal text (not regex) — $, backslashes etc. in new_string are treated as plain characters, no escaping needed. " +
    "Must Read first (errors otherwise); when copying old_string, use the actual content after the line-number prefix in Read's output and preserve its real " +
    "indentation — match the codebase's existing style rather than your own formatting preference.\n" +
    "Concurrent Edit calls on the same file are automatically queued, not racing or corrupting each other; but for multiple changes to one file, prefer MultiEdit " +
    "(single atomic commit — all-or-nothing) over several Edit calls, since a mid-sequence failure there would leave the file half-edited.\n" +
    "On success returns a ```diff block and the first changed line number, so you can verify the edit landed in the right place.",
  capability: "write",
  approval: "required",
  schema: z.object({
    path: z.string().describe("相对工作区根目录的文件路径"),
    old_string: z.string().describe("要被替换的原文(需唯一)"),
    new_string: z.string().describe("替换成的新文本"),
    replace_all: z.boolean().optional().describe("是否替换全部出现"),
  }),
  handler: async (args, ctx) => {
    const abs = resolveWritePath(ctx.cwd ?? ctx.workspaceRoot, args.path);
    // 同路径"读-改-写"全程持锁:并行编辑同一文件时排队,杜绝丢改动 / 撞临时文件。
    return withFileLock(abs, async () => {
      if (ctx.readFiles && !ctx.readFiles.has(abs)) {
        throw new Error(`编辑前请先用 Read 读过它:${args.path}`);
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
      // 首处匹配所在行号(1-based),供 TUI 给 diff 标行号(参考)。
      const startLine = raw.slice(0, raw.indexOf(args.old_string)).split("\n").length;
      // 带行号+上下文的 diff hunk(```diff 块):模型可读、TUI 据此渲染(复刻 CC)。
      const hunk = buildEditHunk(raw, args.old_string, args.new_string);
      const diffBlock = hunk.length ? `\n\`\`\`diff\n${hunk.join("\n")}\n\`\`\`` : "";
      return msg(`已编辑 ${args.path}(替换 ${args.replace_all ? count : 1} 处,行 ${startLine})${diffBlock}`, `Edited ${args.path} (${args.replace_all ? count : 1} replacement(s), line ${startLine})${diffBlock}`);
    });
  },
});
