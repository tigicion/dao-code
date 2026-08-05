import { z } from "zod";
import { defineTool } from "./types.js";

// 参考 EnterPlanMode/ExitPlanMode:模型可主动进入/退出规划模式。
// plan 模式下写/执行类工具从工具表移除(只读+提方案);exit 切回 normal。
export const enterPlanModeTool = defineTool({
  name: "EnterPlanMode",
  description:
    "进入规划模式(只读)。在动手写代码前,先用它探索代码库、设计方案、获得用户确认。" +
    "适用于新功能、多种可行方案、架构决策、多文件改动等场景。进入后只能用只读工具(Read/Grep/ListDir等)," +
    "写/执行类工具不可用。设计好方案后用 ExitPlanMode 退出并请求审批(交互式会话下会真的阻塞等用户批准)。" +
    "无人值守(headless/eval)会话下没有人能批准退出,调用本工具不会真的进入 plan 模式,直接继续正常执行。",
  descriptionEn:
    "Enter plan mode (read-only). Use before writing code to explore the codebase, design an approach, and get user approval. " +
    "In plan mode, write/exec tools are unavailable; only read-only tools work. After designing, use ExitPlanMode to exit and request approval " +
    "(in interactive sessions this genuinely blocks on user approval). In unattended (headless/eval) sessions there is no one to approve the exit, " +
    "so calling this tool is a no-op and execution continues normally.",
  capability: "plan",
  approval: "auto",
  shouldDefer: true,
  schema: z.object({}),
  handler: async (_args, ctx) => {
    if (!ctx.setMode) return "当前环境不支持模式切换。";
    // headless/eval 会话没有真人能批准 ExitPlanMode 的退出请求,而 plan 模式的权限优先级
    // 高于 yolo(见 index.ts getMode),一旦忘记调用 ExitPlanMode 就会永久卡在只读模式、
    // 没有任何兜底能把它拉出来——所以这类会话直接拒绝进入,而不是进去后再想办法脱困。
    if (ctx.headless) {
      return "当前是无人值守(headless)会话,没有人能批准规划模式的退出请求,进入规划模式没有意义且有卡死风险。继续直接执行,按你的判断推进并如实汇报。";
    }
    ctx.setMode("plan");
    return "已进入规划模式(只读)。探索代码库、设计方案,完成后用 ExitPlanMode 退出。";
  },
});

export const exitPlanModeTool = defineTool({
  name: "ExitPlanMode",
  description:
    "退出规划模式,请求用户审批方案。不需要传 plan 内容--方案在对话中已呈现。" +
    "交互式会话下会真的阻塞等用户选择批准/不批准;用户不批准则仍留在规划模式,需据反馈调整方案后再试。" +
    "无人值守(headless/eval)会话没有人能批准,自动放行切回 normal。" +
    "allowedPrompts 可预声明实现方案需要的权限(如 'run tests'、'install dependencies'),便于用户一键授权。" +
    "不应在纯研究/探索任务中使用;仅用于需要写实现计划的任务。",
  descriptionEn:
    "Exit plan mode and request user approval. No need to pass plan content - it's in the conversation. " +
    "In interactive sessions this genuinely blocks until the user picks approve/reject; on rejection you stay in plan mode and must revise " +
    "based on feedback before retrying. In unattended (headless/eval) sessions there is no one to approve, so it auto-passes back to normal. " +
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
    // 只有真正交互式会话才有 ctx.askChoice(index.ts 只在 interactiveSession 下注入,
    // headless/eval 场景没有,与 AskUserQuestion 的降级判断同一口径)——这里才真的
    // 阻塞等一次人工审批,而不是像之前那样直接自我批准。没有 askChoice 的场景没人能
    // 批准,保持自动通过(EnterPlanMode 已经把这类会话挡在门外,理论上走不到这里)。
    if (ctx.askChoice) {
      const approved = "批准,开始实现";
      const rejected = "不批准,继续讨论";
      const answer = await ctx.askChoice(
        "已设计好方案,是否批准并退出规划模式开始实现?",
        [approved, rejected],
      );
      if (!answer.startsWith("批准")) {
        return `用户未批准方案(回应:${answer})。仍在规划模式,根据反馈调整方案后再试。`;
      }
    }
    ctx.setMode("normal");
    return "已退出规划模式,切回 normal。可以开始实现方案。";
  },
});
