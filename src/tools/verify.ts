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
    "判断任务是否真正完成。配置了验收命令时跑它(exit 0=通过/非0=未完成,继续修);未配置时提示你据证据自判。声称完成前先调用它。",
  descriptionEn:
    "Determines whether a task is truly complete. If an acceptance command is configured, runs it (exit 0=pass / non-0=fail, keep fixing); otherwise prompts you to self-judge based on evidence. Call this before claiming completion.",
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
