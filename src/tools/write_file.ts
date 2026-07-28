import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool } from "./types.js";
import { resolveWritePath } from "./paths.js";
import { atomicWrite } from "./fs_atomic.js";
import { withFileLock } from "./file_lock.js";
import { msg } from "./lang.js";

export const writeFileTool = defineTool({
  name: "Write",
  description: "在工作区内新建文件,或整篇重写一个已存在的文件——content 是文件的完整内容,原内容整段被替换掉,没有 diff。" +
    "新建文件不需要先读;覆盖已存在文件前必须先用 Read 读过它(没读过会直接拒绝)。" +
    "若文件自上次 Read 后被外部改动过(mtime/size 变化,如用户手改或其它进程写了它),会拒绝写入并提示重新 Read——" +
    "防止你拿着旧内容整篇覆盖掉别人刚做的改动;遇到这个报错,重新读一遍最新内容,再决定要不要接着写。\n" +
    "只改一部分内容优先用 Edit/MultiEdit(基于原文精确替换,改动可见、不会误删你没打算动的部分)," +
    "不要为了改几行就把整篇内容重新敲一遍传进来——那样既容易在无关处引入疏漏,diff 也没法审查具体改了什么。" +
    "对同一路径连续两次整篇重写、中间没有任何 Bash 调用去验证过第一版,会直接拒绝——先运行第一版拿到" +
    "真实反馈(哪怕只是编译错误),或改用 Edit/MultiEdit 做局部修正,别凭记忆判断'思路不对'就整篇丢弃重写。\n" +
    "写入是原子的(先写临时文件再替换),中途崩溃不会留下半截文件。\n" +
    "内容特别长(预计上万字符/几千行)时,不要试图一次调用写完整篇——单次输出有预算上限,写到一半被截断会" +
    "直接失败且这次生成完全作废。改成分批:先 Write 写核心骨架或前一部分,再用 Edit/MultiEdit 追加/续写剩余部分。",
  descriptionEn: "Creates a new file, or completely overwrites an existing one — content is the file's full text, replacing everything, no diff. " +
    "New files don't need a prior read; overwriting an existing file requires Read first (rejected otherwise). " +
    "Rejects the write (and asks you to re-read) if the file changed externally since your last Read (mtime/size drift, e.g. the user hand-edited it or another process wrote it) — " +
    "prevents you from clobbering someone else's recent change with stale content; on this error, re-read the current content before deciding whether to write again.\n" +
    "For partial changes, prefer Edit/MultiEdit (precise replacement against the original, changes are reviewable, nothing unrelated gets touched) instead of retyping the whole " +
    "file just to change a few lines — that risks introducing unrelated slips and the diff can't show exactly what changed. " +
    "A second full rewrite of the same path with no Bash call in between to verify the first version is rejected — run the first version to get real " +
    "feedback (even a compile error counts), or use Edit/MultiEdit for a targeted fix; don't discard a version you never ran just because you think the approach is wrong. " +
    "Writes are atomic (write to a temp file then swap in) — a crash mid-write never leaves a half-written file.\n" +
    "For especially long content (tens of thousands of characters / thousands of lines), don't try to write the whole thing in one call — a single response has an output budget, " +
    "and getting cut off mid-write fails outright and wastes that entire generation. Split it: Write the skeleton or first part, then Edit/MultiEdit to append/continue the rest.",
  capability: "write",
  approval: "required",
  schema: z.object({
    path: z.string().describe("相对工作区根目录的文件路径"),
    content: z.string().describe("文件的完整内容"),
  }),
  handler: async (args, ctx) => {
    const abs = resolveWritePath(ctx.cwd ?? ctx.workspaceRoot, args.path);
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
        throw new Error(`覆盖已存在文件前请先用 Read 读过它:${args.path}`);
      }
      // 对同一路径的第二次整篇重写,中间必须有过至少一次 Bash/exec_shell 调用(不要求针对
      // 这个文件本身,任何一次真实执行都算)。真实撞见:模型写完一版从未运行就凭记忆判断
      // "思路不对"整篇重写,写下来的版本比只存在于推理里的完美设计更有价值。Edit/MultiEdit
      // 不受此限制——那正是这条规则本身推荐的局部修正替代方案。
      if (exists && ctx.pendingUnverifiedWrites?.has(abs)) {
        throw new Error(
          `拒绝写入:你正在整篇重写 ${args.path},但自上次写入以来还没有执行过任何命令去验证那一版本。` +
          `写下来的版本比只存在于推理里的完美设计更有价值——先运行它拿到真实反馈(哪怕只是编译错误),` +
          `不要凭记忆判断"这版思路不对"就整篇丢弃重写。如果你已经明确知道具体哪里错了、想做局部修正,` +
          `用 Edit/MultiEdit 针对性修改不受此限制;如果确实需要先验证,现在就去跑一下上一版。`,
        );
      }
      // P2-23 mtime/size 复核:文件自上次 read 后被外部改动 → 拒绝(防整体重写覆盖用户/外部的并发编辑)。
      if (exists) {
        const meta = ctx.readMeta?.get(abs);
        if (meta) {
          const cur = await fs.stat(abs);
          if (cur.mtimeMs !== meta.mtime || cur.size !== meta.size) {
            throw new Error(`文件自上次 Read 后已被外部改动:${args.path}。请重新 Read 看最新内容再写,以免覆盖他人改动。`);
          }
        }
      }
      await atomicWrite(abs, args.content);
      try { const w = await fs.stat(abs); ctx.readMeta?.set(abs, { mtime: w.mtimeMs, size: w.size }); } catch { /* ignore */ } // 写后刷新基线
      ctx.readFiles?.add(abs);
      ctx.pendingUnverifiedWrites?.add(abs);
      ctx.onFileAccessed?.(abs).catch(() => {});
      return msg(`已写入 ${args.path}(${args.content.split("\n").length} 行)`, `Wrote ${args.path} (${args.content.split("\n").length} lines)`);
    });
  },
});
