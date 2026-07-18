import { z } from "zod";
import { defineTool } from "./types.js";

// 对标 CC EnterPlanMode/ExitPlanMode:模型可主动进入/退出规划模式。
// plan 模式下写/执行类工具从工具表移除(只读+提方案);exit 切回 normal。
export const enterPlanModeTool = defineTool({
  name: "EnterPlanMode",
  description:
    "进入规划模式(只读)。在动手写代码前,先用它探索代码库、设计方案、获得用户确认。" +
    "适用于新功能、多种可行方案、架构决策、多文件改动等场景。进入后只能用只读工具(Read/Grep/ListDir等)," +
    "写/执行类工具不可用。设计好方案后用 ExitPlanMode 退出并请求审批。",
  descriptionEn:
    "Enter plan mode (read-only). Use before writing code to explore the codebase, design an approach, and get user approval. " +
    "In plan mode, write/exec tools are unavailable; only read-only tools work. After designing, use ExitPlanMode to exit and request approval.",
  capability: "plan",
  approval: "auto",
  shouldDefer: true,
  schema: z.object({}),
  handler: async (_args, ctx) => {
    if (!ctx.setMode) return "当前环境不支持模式切换。";
    ctx.setMode("plan");
    return "已进入规划模式(只读)。探索代码库、设计方案,完成后用 ExitPlanMode 退出。";
  },
});

export const exitPlanModeTool = defineTool({
  name: "ExitPlanMode",
  description:
    "退出规划模式,切回 normal 模式并请求用户审批方案。不需要传 plan 内容--方案在对话中已呈现。" +
    "allowedPrompts 可预声明实现方案需要的权限(如 'run tests'、'install dependencies'),便于用户一键授权。" +
    "不应在纯研究/探索任务中使用;仅用于需要写实现计划的任务。",
  descriptionEn:
    "Exit plan mode, switch back to normal mode and request user approval. No need to pass plan content - it's in the conversation. " +
    "allowedPrompts pre-declares permissions needed (e.g. 'run tests', 'install dependencies') for one-click authorization. " +
    "Not for pure research/exploration; only for tasks that need an implementation plan.",
  capability: "plan",
  approval: "auto",
  shouldDefer: true,
  schema: z.object({
    allowedPrompts: z.array(z.object({
      tool: z.enum(["Bash"]).describe("要预授权的工具(目前只支持 Bash)"),
      prompt: z.string().describe("语义化描述,如 'run tests'、'install dependencies'"),
    })).optional().describe("实现方案需要的权限预声明"),
  }),
  handler: async (_args, ctx) => {
    if (!ctx.setMode) return "当前环境不支持模式切换。";
    ctx.setMode("normal");
    return "已退出规划模式,切回 normal。可以开始实现方案。";
  },
});
