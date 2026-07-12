import { exec } from "node:child_process";
import { z } from "zod";
import { defineTool } from "./types.js";
import { spillOutput } from "./spill.js";
import { msg } from "./lang.js";

// 验证驱动的"完成定义"(DoD):
// - 若配置了可执行验收命令(ctx.verifyCommand,经 /dod 或 DAO_VERIFY_CMD 设置)→ 跑它,exit 0 = 通过。
// - 未配置 → 返回提示,要求模型据实际证据自行判断完成。
// 声称任务完成前应先调用本工具(见系统 prompt 的验证纪律)。
export const verifyDoneTool = defineTool({
  name: "verify_done",
  description:
    "判断任务是否真正完成。配置了验收命令(/dod 或 DAO_VERIFY_CMD 设置)时真的跑它(300 秒超时,输出会截断)," +
    "exit 0=通过、非 0=未完成继续修;没配置时不会帮你瞎判断,而是提醒你必须拿【实际证据】自己判——读代码≠验证," +
    "真把它跑起来、读回改动、看输出,不能用'看起来对/应该没问题/我的测试过了'代替独立验证。每次声称任务完成前都调用它," +
    "不是只在一长串工作的最后调一次——中途每完成一个可验证的子目标就调一次,别攒到最后才发现前面某步其实没做对。" +
    "举例:改完一个函数就该跑一下它的单测,而不是等改完十个文件、准备收尾时才第一次验证,那样出问题定位成本高得多。" +
    "这里的通过只代表配置的命令退出码是 0,不代表功能真的做对了——如果命令本身太浅(比如只跑了类型检查),通过了也不等于验证完整。",
  descriptionEn:
    "Determines whether a task is truly complete. If an acceptance command is configured (via /dod or DAO_VERIFY_CMD), actually runs it (300s timeout, output truncated), " +
    "exit 0=pass, non-zero=not done yet, keep fixing; if none is configured, it won't quietly let you self-approve — instead it reminds you to judge based on [actual evidence]: " +
    "reading code ≠ verifying it, actually run it / read back the change / check the output — don't substitute 'looks right' / 'should be fine' / 'my tests passed' for " +
    "independent verification. Call this before every claim of completion, not just once at the end of a long task — call it after each verifiable sub-goal along the way, " +
    "rather than discovering at the very end that an earlier step wasn't actually right. Example: run a function's unit tests right after changing it, rather than " +
    "waiting until ten files later when you're wrapping up to verify for the first time — much more expensive to pinpoint the problem that way. A pass here means the " +
    "configured command exited 0, nothing more — it doesn't certify the feature is actually correct if the command itself is too shallow (e.g. only a type check).",
  capability: "read",
  approval: "auto",
  schema: z.object({}),
  handler: async (_args, ctx) => {
    const cmd = ctx.verifyCommand?.trim();
    if (!cmd) {
      return msg(
        "(未配置可执行验收命令)据【实际证据】自判,别自我合理化:读≠验证——真把它跑起来 / 读回改动 / 看输出。别用\"代码看起来对、大概没问题、我的测试过了\"代替验证;独立验一遍,再说明完成依据。",
        "(No executable acceptance command configured) Self-judge based on [actual evidence]; don't self-rationalize: reading ≠ verification — actually run it / read back changes / check output. Don't substitute \"code looks right\", \"should be fine\", or \"my tests passed\" for verification; independently verify, then state the basis for completion.",
      );
    }
    return await new Promise<string>((resolve) => {
      const child = exec(
        cmd,
        { cwd: ctx.workspaceRoot, timeout: 300000, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code = err && typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
          const body = [stdout, stderr].filter((s) => s && s.trim()).join("\n").trimEnd();
          resolve(`$ ${cmd}\n${spillOutput(body, ctx.workspaceRoot)}\n${msg(`[验收${code === 0 ? "通过" : "失败"} exit ${code}]`, `[Verification ${code === 0 ? "PASSED" : "FAILED"} exit ${code}]`)}`);
        },
      );
      ctx.signal?.addEventListener("abort", () => { try { child.kill("SIGTERM"); } catch {} }, { once: true });
    });
  },
});
