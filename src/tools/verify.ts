import { exec } from "node:child_process";
import { z } from "zod";
import { defineTool } from "./types.js";
import { spillOutput } from "./spill.js";

// 验证驱动的"完成定义"(DoD):
// - 若配置了可执行验收命令(ctx.verifyCommand,经 /dod 或 DAO_VERIFY_CMD 设置)→ 跑它,exit 0 = 通过。
// - 未配置 → 返回提示,要求模型据实际证据自行判断完成。
// 声称任务完成前应先调用本工具(见系统 prompt 的验证纪律)。
export const verifyDoneTool = defineTool({
  name: "verify_done",
  description:
    "判断任务是否真正完成。配置了验收命令时跑它(exit 0=通过/非0=未完成,继续修);未配置时提示你据证据自判。声称完成前先调用它。",
  capability: "read",
  approval: "auto",
  schema: z.object({}),
  handler: async (_args, ctx) => {
    const cmd = ctx.verifyCommand?.trim();
    if (!cmd) {
      return "(未配置可执行验收命令)请据实际证据自判是否完成:读回关键改动、跑相关测试/命令看输出,并向用户说明完成依据。";
    }
    return await new Promise<string>((resolve) => {
      const child = exec(
        cmd,
        { cwd: ctx.workspaceRoot, timeout: 300000, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code = err && typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
          const body = [stdout, stderr].filter((s) => s && s.trim()).join("\n").trimEnd();
          resolve(`$ ${cmd}\n${spillOutput(body, ctx.workspaceRoot)}\n[验收${code === 0 ? "通过" : "失败"} exit ${code}]`);
        },
      );
      ctx.signal?.addEventListener("abort", () => { try { child.kill("SIGTERM"); } catch {} }, { once: true });
    });
  },
});
