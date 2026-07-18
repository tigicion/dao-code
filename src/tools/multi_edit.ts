import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool } from "./types.js";
import { resolveWritePath } from "./paths.js";
import { atomicWrite } from "./fs_atomic.js";
import { withFileLock } from "./file_lock.js";
import { buildEditHunk } from "./diff_hunk.js";
import { msg } from "./lang.js";

// 对一个文件按顺序应用多处精确替换,原子(全部成功才写盘,任一处失败则整体不动)。参考 的 MultiEdit。
export const multiEditTool = defineTool({
  name: "MultiEdit",
  description:
    "对工作区内一个文件按顺序应用多处精确字符串替换;原子操作——任一处失败则整体不写盘,不会留下改了一半的文件。" +
    "编辑前需先用 Read 读过它。每处 old_string 须在【施加该处时的内容】(即前面几处已生效后)中唯一,或设 replace_all;" +
    "第 N 处失败会报清楚是第几处、原文是什么,方便你调整。同一文件要做多处相关改动时,优先用这个而不是连发多个 Edit——" +
    "后者中途某一处失败会留下部分改动,这个不会。仍然是精确替换,不是整篇重写;局部改动别用 Write。" +
    "成功后返回每处改动的 ```diff 块,可以直接确认全部改对了地方。举例:重命名一个跨文件都用到的局部变量、" +
    "同时改掉它的三处引用和一处注释,四处一起提交比连发四次 Edit 更安全,任何一处没匹配上就整体回滚。",
  descriptionEn:
    "Applies multiple exact string replacements to a workspace file sequentially; atomic — all succeed or nothing is written, never leaving a half-edited file. " +
    "Must Read first. Each old_string must be unique at its application point (i.e. after earlier edits in the sequence have already applied), or set replace_all; " +
    "a failure on the Nth edit reports which one and what text it was looking for, so you can adjust. For multiple related changes to one file, prefer this over several " +
    "Edit calls — a mid-sequence failure there leaves partial changes, this doesn't. Still precise replacement, not a full rewrite; don't use Write for partial changes. " +
    "On success returns a ```diff block per edit so you can verify everything landed correctly. Example: renaming a locally-used variable along with three references " +
    "and one comment in the same file — submitting all four together is safer than four separate Edit calls, since any single mismatch rolls back everything.",
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
    const abs = resolveWritePath(ctx.cwd ?? ctx.workspaceRoot, args.path);
    return withFileLock(abs, async () => {
      if (ctx.readFiles && !ctx.readFiles.has(abs)) {
        throw new Error(`编辑前请先用 Read 读过它:${args.path}`);
      }
      let text = await fs.readFile(abs, "utf8");
      let total = 0;
      const hunks: string[] = [];
      // 先全部校验+施加到内存,全部通过才落盘(原子)。
      for (let i = 0; i < args.edits.length; i++) {
        const e = args.edits[i]!;
        const count = text.split(e.old_string).length - 1;
        if (count === 0) throw new Error(`第 ${i + 1} 处未找到 old_string(整体未改):${e.old_string.slice(0, 40)}`);
        if (count > 1 && !e.replace_all) {
          throw new Error(`第 ${i + 1} 处 old_string 出现 ${count} 次、不唯一;用 replace_all 或扩大上下文(整体未改)`);
        }
        // 每处编辑生成 diff hunk(基于当前文本,施加前)
        const hunk = buildEditHunk(text, e.old_string, e.new_string);
        if (hunk.length) hunks.push(["```diff", ...hunk, "```"].join("\n"));
        text = text.split(e.old_string).join(e.new_string);
        total += e.replace_all ? count : 1;
      }
      await atomicWrite(abs, text);
      const diffBlock = hunks.length ? `\n${hunks.join("\n")}` : "";
      return msg(
        `已编辑 ${args.path}(${args.edits.length} 组替换,共 ${total} 处)${diffBlock}`,
        `Edited ${args.path} (${args.edits.length} edit group(s), ${total} replacement(s) total)${diffBlock}`,
      );
    });
  },
});
