import { z } from "zod";
import { defineTool } from "./types.js";
import type { ChatMessage } from "../client/types.js";
import type { AgentDef } from "../agent/agent_defs.js";
import { FORK_AGENT, buildForkContextMessages } from "../agent/fork_agent.js";
import { finalizeAgentTool } from "../agent/agent_tools.js";
import { runAsyncAgentLifecycle, type AsyncAgentTaskManager } from "../agent/agent_lifecycle.js";
import { classifyHandoffIfNeeded } from "../agent/agent_handoff.js";
import type { ForegroundRegistry } from "../tui/foreground_registry.js";

// 子代理模型名归一化:模型常把 "deepseek-v4-pro" 写成 "deepseek-v4"/"pro"/"flash" -> raw 传 API 会失败。
// 已知模型名(含 kimi-k2.6/glm-5.2 等多 provider)原样保留;deepseek 简称归一;无法识别 -> undefined(继承父模型)。
import { MODELS_BY_PROVIDER } from "../config/profiles.js";

const ALL_KNOWN_MODELS = new Set(
  Object.values(MODELS_BY_PROVIDER).flat().map((m) => m.toLowerCase()),
);

export function normalizeModel(m: string | undefined): string | undefined {
  if (!m) return undefined;
  const s = m.trim().toLowerCase();
  if (ALL_KNOWN_MODELS.has(s)) return m.trim();
  if (s.includes("flash")) return "deepseek-v4-flash";
  if (s.includes("pro")) return "deepseek-v4-pro";
  return undefined;
}

function randomAgentId(): string {
  return `agent-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
}

// AgentTool 动态描述(会话内固定,不含 agent 列表 -> 工具 schema 缓存安全)。
// agent 列表在 system prompt 的"可用子代理类型"段,变更不 bust 工具描述缓存。
const AGENT_TOOL_PROMPT_ZH =
  "把独立子任务派发给子代理:它用同样的工具自主跑完、只返回最终结果(你看不到中间过程)。" +
  "任务描述要自包含--子代理没有当前对话上下文。传 task 派单个;传 tasks 数组并行派发并汇总。" +
  "并行任务务必彼此独立、互不依赖;需要同时改文件的任务不要并行。子代理内不能再派子代理(不支持嵌套)。" +
  "前台/后台按依赖关系判断,不是按耗时:下一步依赖这个结果就前台等(前台会老实等到跑完,不会因为" +
  "耗时长被自动转后台);跟下一步没有依赖才用 background:true。并行最多 10 个同时跑、其余排队。\n" +
  "四个可选调用方式互斥:isolate(git worktree 隔离改文件)、fork(继承完整上下文+复用前缀缓存,近乎免费)、" +
  "model(临时换模型省钱,但会让前缀缓存失效)、mode=plan(只读规划)。fork 与 model/mode 天生冲突。" +
  "agent_type 指定子代理类型(见系统 prompt 的'可用子代理类型');省略则用通用子代理。\n" +
  "拿到结果后留个心眼:子代理返回的是它自称做了什么,不是你亲眼确认过的事实。" +
  "涉及代码改动的子任务,回来后亲自复核关键结论,不要原样转述子代理的自述。" +
  "别重复子代理正在做的工作:如果你把一项调查派给了子代理,就不要自己也去跑同样的搜索。\n" +
  "何时不该用:要读某个具体文件路径,直接 Read;要搜某个类/函数定义,直接 Grep/Glob;" +
  "只需在 2-3 个文件里搜代码,直接 Read。这些简单搜索不值得派子代理。\n" +
  "长耗时子任务策略:派发前自判子任务是否可能耗时超过 180 秒。如果是,优先 background:true 后台派--" +
  "不只是\"起后台等通知\",而是:做完别的事后用 TaskOutput 做 checkpoint 式进度检查," +
  "看子代理的中间消息/思考判断是否在正常推进;发现趋势偏离预期用 TaskStop 终止," +
  "分析已产生的中间结果,调整策略再重新派发。前台子代理耗时过长时同理--" +
  "可以先用 TaskOutput 看中间进度,趋势不对就 TaskStop。\n" +
  "写 prompt 的指引:像给刚进门的聪明同事 brief--子代理没看过当前对话,不知道你试过什么、为什么这个任务重要。" +
  "说清目标与背景、已排除的方向、需要判断而非窄指令的上下文。需要短回复就说『200 字以内回报』。" +
  "查/定位:给确切命令;调查:给问题而非规定步骤。别写『基于你的发现修复 bug』--那是把综合判断推给子代理;" +
  "写能证明你理解了的 prompt:含文件路径、行号、具体改什么。\n" +
  "示例:\n" +
  "派 explore 子代理并行调查(非 fork):\n" +
  "  agent({ task: \"查清 src/auth/ 下所有密码校验逻辑的调用链,报告每个入口点和校验规则\", agent_type: \"explore\" })\n" +
  "fork 自己做分支尝试(继承上下文,省缓存):\n" +
  "  agent({ task: \"把 ValidationError 改成继承 AppError 并更新所有 catch 块\", fork: true })";

const AGENT_TOOL_PROMPT_EN =
  "Dispatches an independent subtask to a subagent: it runs autonomously with the same tools and returns only the final result (you don't see intermediate steps). " +
  "Task description must be self-contained - the subagent has no current conversation context. Pass task for a single dispatch; pass tasks array for parallel dispatch with aggregated results. " +
  "Parallel tasks MUST be mutually independent; tasks modifying the same files must not be parallelized. No nesting (a subagent cannot dispatch its own subagent). " +
  "Foreground vs background is a dependency call, not a duration call: run foreground when your next step " +
  "depends on the result (it waits until actually done, never silently auto-converted to background); use " +
  "background:true only when the result has no bearing on your next step. At most 10 parallel, the rest queue.\n" +
  "Four optional modes are mutually exclusive: isolate (git worktree isolation), fork (inherits full context + reuses prefix cache, nearly free), " +
  "model (temporarily switch models - invalidates prefix cache), mode=plan (read-only planning). fork conflicts with model/mode. " +
  "agent_type selects a subagent type (see 'Available Subagent Types' in system prompt); omit for generic subagent.\n" +
  "Trust but verify: a subagent's summary describes what it claims it did, not what you've confirmed. " +
  "For code-change subtasks, verify key results yourself before reporting. " +
  "Don't duplicate work that subagents are already doing - if you delegate research to a subagent, do not also perform the same searches yourself.\n" +
  "When NOT to use: to read a specific file path, use Read directly; to search for a class/function definition, use Grep/Glob directly; " +
  "to search within 2-3 specific files, use Read directly. These simple searches don't warrant a subagent.\n" +
  "Long-running subtask strategy: before dispatching, judge whether the subtask may take over 180 seconds. If so, prefer background:true - " +
  "not just \"start it in background and wait for notification\", but: after doing other work, use TaskOutput for checkpoint-style progress " +
  "checks, looking at the subagent's intermediate messages/reasoning to judge whether it's advancing normally; if the trend diverges from " +
  "expectation, use TaskStop to terminate, analyze the intermediate results produced, adjust strategy and re-dispatch. The same applies " +
  "to foreground subagents taking too long - use TaskOutput to check intermediate progress first, and TaskStop if the trend looks wrong.\n" +
  "Writing the prompt: brief the agent like a smart colleague who just walked into the room - it hasn't seen this conversation. " +
  "Explain what you're trying to accomplish and why. Describe what you've already learned or ruled out. " +
  "Give enough context for judgment calls. If you need a short response, say so. Lookups: hand over the exact command. " +
  "Investigations: hand over the question - prescribed steps become dead weight when the premise is wrong. " +
  "Don't write 'based on your findings, fix the bug' - that pushes synthesis onto the agent; write prompts that prove you understood: include file paths, line numbers, what specifically to change.\n" +
  "Examples:\n" +
  "Dispatch explore subagent for parallel investigation (non-fork):\n" +
  "  agent({ task: \"Trace all password validation call chains under src/auth/, report each entry point and validation rule\", agent_type: \"explore\" })\n" +
  "Fork yourself for a branch attempt (inherits context, saves cache):\n" +
  "  agent({ task: \"Change ValidationError to extend AppError and update all catch blocks\", fork: true })";

export const agentTool = defineTool({
  name: "Agent",
  description:
    "把独立子任务派发给子代理:它用同样的工具自主跑完、只返回最终结果(你看不到中间过程)。" +
    "任务描述要自包含——子代理没有当前对话上下文。" +
    "传 task 派单个;传 tasks 数组则并行派发多个并汇总(适合可并行的独立调查/分析)。" +
    "并行任务务必彼此独立、互不依赖;需要同时改文件的任务不要并行,以免互相冲突。" +
    "子代理内不能再派子代理(不支持嵌套)。" +
    "前台/后台按依赖关系判断,不是按耗时:接下来要做什么依赖这个子代理的结果(先查清楚现状/定位问题," +
    "再决定怎么改这类调查→动手的链式任务)就前台等,反正也没法跳过这一步先做别的;结果跟接下来的动作" +
    "没有依赖关系(独立的长时间构建/评测,或你想边跑边继续做别的事/跟用户聊别的)才用 background:true。" +
    "前台调用会老实等到跑完,不会因为耗时长就被偷偷转后台——如果一个前台调用明显不该等这么久,自己判断" +
    "要不要拆成 background 重新派发,而不是指望系统帮你打断。" +
    "并行任务默认最多 10 个同时跑,其余排队,不代表真的全部同时执行。\n" +
    "四个可选调用方式互斥、别混用:isolate(独立 git worktree 里改文件,并行改文件不冲突,改动留在分支供你事后 review/merge)、" +
    "fork(继承你当前完整上下文+复用前缀缓存,近乎免费,适合带全量背景做分支尝试)、model(临时换模型,通常为了省钱跑廉价任务," +
    "但换模型本身会让前缀缓存失效,不够便宜的任务不划算)、mode=plan(只读规划模式)。fork 和 model/mode 天生冲突——fork 的" +
    "价值就是复用缓存,换模型/换模式会让这份缓存作废。agent_type 指定自定义子代理类型(有专属 prompt/工具白名单),不给就是通用子代理。" +
    "拿到结果后留个心眼:子代理返回的是它自称做了什么,不是你亲眼确认过的事实——它可能把「应该改好了」当「已经改好了」报回来。" +
    "涉及代码改动、修 bug、跑测试这类子任务,回来后花一次工具调用亲自复核关键结论(读一下实际 diff、跑一下它说过的命令)," +
    "不要原样把子代理的自述转述给用户当作你自己验证过的结论。" +
    "别重复子代理正在做的工作:如果你把一项调查派给了子代理,就不要自己也去跑同样的搜索。\n" +
    "何时不该用:要读某个具体文件路径,直接 Read;要搜某个类/函数定义,直接 Grep/Glob;只需在 2-3 个文件里搜代码,直接 Read。这些简单搜索不值得派子代理。\n" +
    "写 prompt 的指引:像给刚进门的聪明同事 brief--子代理没看过当前对话,不知道你试过什么、为什么这个任务重要。说清目标与背景、已排除的方向、需要判断而非窄指令的上下文。需要短回复就说『200 字以内回报』。查/定位:给确切命令;调查:给问题而非规定步骤。别写『基于你的发现修复 bug』--那是把综合判断推给子代理;写能证明你理解了的 prompt:含文件路径、行号、具体改什么。",
  descriptionEn:
    "Dispatches an independent subtask to a subagent: it runs autonomously with the same tools and returns only the final result (you don't see intermediate steps). " +
    "Task description must be self-contained — the subagent has no current conversation context. " +
    "Pass task for a single dispatch; pass tasks array for parallel dispatch with aggregated results (ideal for parallel independent investigation/analysis). " +
    "Parallel tasks MUST be mutually independent with no dependencies; tasks that modify the same files must not be parallelized to avoid conflicts. " +
    "A subagent cannot dispatch its own subagent (no nesting). " +
    "Foreground vs background is a dependency call, not a duration call: run foreground (the default) when your next " +
    "step depends on this subagent's result — look-something-up-then-act chains where there's nothing useful to do " +
    "until you have the answer anyway. Pass background:true only when the result has no bearing on what you do next " +
    "(an independent long-running build/eval, or you genuinely want to keep working on something else / talking to the " +
    "user while it runs). A foreground call waits until it's actually done, no matter how long — it will not be " +
    "silently converted to background just because it's taking a while; if a foreground call is clearly running too " +
    "long, that's your call to make (re-dispatch it as background), not something the system does for you. " +
    "Parallel tasks run at most 10 concurrently by default — the rest queue, so not all tasks truly run simultaneously.\n" +
    "Four optional dispatch modes are mutually exclusive, don't mix them: isolate (edits happen in an isolated git worktree, safe to parallelize file changes, " +
    "changes are left on a branch for you to review/merge afterward), fork (inherits your full current context + reuses the prefix cache, nearly free — good for a " +
    "branch attempt with full background), model (temporarily switch models, usually to run a cheap task on a cheaper model — but switching itself invalidates the " +
    "prefix cache, not worth it unless the task is cheap enough), mode=plan (read-only planning mode). fork inherently conflicts with model/mode — fork's whole value " +
    "is reusing the cache, and switching model/mode invalidates that cache. agent_type selects a custom subagent type (with its own prompt/tool allowlist); omit for a generic subagent. " +
    "Trust but verify what comes back: a subagent's summary describes what it claims it did, not what you've confirmed happened — it may report \"should be fixed\" as " +
    "\"fixed\". For subtasks touching code changes, bug fixes, or tests, spend one follow-up tool call checking the actual result yourself (read the real diff, run the " +
    "command it says it ran) before reporting the subagent's account to the user as your own verified conclusion. " +
    "Don't duplicate work that subagents are already doing - if you delegate research to a subagent, do not also perform the same searches yourself.\n" +
    "When NOT to use: to read a specific file path, use Read directly; to search for a class/function definition, use Grep/Glob directly; to search within 2-3 specific files, use Read directly. These simple searches don't warrant a subagent.\n" +
    "Writing the prompt: brief the agent like a smart colleague who just walked into the room - it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters. Explain what you're trying to accomplish and why. Describe what you've already learned or ruled out. Give enough context that the agent can make judgment calls rather than just following a narrow instruction. If you need a short response, say so. Lookups: hand over the exact command. Investigations: hand over the question - prescribed steps become dead weight when the premise is wrong. Don't write 'based on your findings, fix the bug' - that pushes synthesis onto the agent; write prompts that prove you understood: include file paths, line numbers, what specifically to change.",
  capability: "plan",
  approval: "auto",
  schema: z.object({
    task: z.string().min(1).optional().describe("单个子任务(与 tasks 二选一)"),
    tasks: z
      .array(z.string().min(1))
      .min(1)
      .max(20)
      .optional()
      .describe("多个相互独立的子任务,并行派发并汇总(最多 20 个;最多 10 个同时跑、其余自动排队)"),
    background: z
      .boolean()
      .optional()
      .describe("后台运行:立即返回任务 id 不阻塞,完成后结果会自动通知你。按依赖关系判断,不是按耗时:结果跟你接下来的动作没有依赖(独立的长任务,或你想边跑边做别的事)才用;接下来要做什么依赖这个结果就别传,老实前台等——前台不会因为耗时长被自动转后台。"),
    agent_type: z
      .string()
      .optional()
      .describe("指定自定义子代理类型(见系统 prompt 的'可用子代理类型');省略则用通用子代理。"),
    isolate: z
      .boolean()
      .optional()
      .describe("git worktree 隔离的快捷方式(等同 isolation:\"worktree\")。"),
    isolation: z
      .enum(["worktree", "remote"])
      .optional()
      .describe("隔离模式:worktree=在独立 git 工作树里改文件;remote=在 headless 子进程里跑(独立进程,无缓存复用)。与 fork 互斥。"),
    fork: z
      .boolean()
      .optional()
      .describe("fork 模式:子代理继承你当前的【完整上下文】(复用前缀缓存,近乎免费)再做这件事。适合'带全量背景做一个分支调查/尝试';与 agent_type/isolate 互斥。"),
    model: z
      .string()
      .optional()
      .describe("调用级模型覆盖(如 deepseek-v4-flash 省钱跑廉价子任务)。注意:换模型会让前缀缓存失效——只在任务足够廉价时才划算。与 fork 互斥。"),
    mode: z
      .enum(["normal", "plan"])
      .optional()
      .describe("调用级权限模式覆盖:plan=只读规划。省略则继承 agent 定义/默认模式。与 fork 互斥。"),
  }),
  // 动态描述生成(参考 getPrompt):产出会话内固定的完整描述(含 when-not-to-use / writing-prompt / 示例),
  // 不含 agent 列表(agent 列表在 system prompt 层,变更不 bust 工具 schema 缓存)。
  prompt: ({ lang }) => {
    if (lang === "en") {
      return AGENT_TOOL_PROMPT_EN;
    }
    return AGENT_TOOL_PROMPT_ZH;
  },
  handler: async (args, ctx) => {
    // 防御性嵌套检查:agent 工具本就在 ALL_AGENT_DISALLOWED_TOOLS 里对所有子代理全局禁用,
    // 子代理的工具池里根本没有这个工具——这里是第二道防线,正常不会触发。
    if ((ctx.subagentDepth ?? 0) >= 1) {
      return "子代理内不能再派子代理(不支持嵌套)。请自己完成这件事,或把它拆小后在结论里回报需要继续的部分。";
    }
    if (!ctx.runAgent) {
      return "当前环境不支持子代理。";
    }
    const agentDefs = ctx.agentDefinitions ?? [];
    const type = args.agent_type;
    if (type && !agentDefs.some((d) => d.agentType === type)) {
      const avail = agentDefs.map((d) => d.agentType).join(", ") || "(无)";
      return `未知子代理类型「${type}」。可用:${avail}。`;
    }
    if (args.fork && (args.model || args.mode)) {
      return "fork 与 model/mode 覆盖互斥:fork 的价值是复用父代理的前缀缓存,而换模型/改模式会让该缓存失效、fork 失去意义。请去掉 model/mode,或改用普通子代理(去掉 fork)。";
    }
    if (args.background && (args.model || args.mode)) {
      return "后台子代理暂不支持 model/mode 覆盖(后续版本补)。若要换模型跑后台:去掉 model/mode,或为该用途定义一个带 model 的 agent_type 再用 background。";
    }

    const runAgent = ctx.runAgent;
    const fork = !!args.fork;
    const agentDef: AgentDef = fork
      ? FORK_AGENT
      : (agentDefs.find((d) => d.agentType === (type ?? "general-purpose")) ?? FORK_AGENT);
    // isolation 优先:显式 isolation 参数 > isolate boolean 快捷方式 > agent 定义 isolation。
    // remote = headless 子进程(暂未实现,回退到 worktree 并提示);worktree = git 工作树隔离。
    const isolationMode = args.isolation ?? (args.isolate ? "worktree" : undefined) ?? agentDef.isolation;
    const isolate = !fork && isolationMode === "worktree" && !!ctx.createWorktree;
    const isRemote = !fork && isolationMode === "remote";
    const reqModel = normalizeModel(args.model); // 归一化/兜底:无效模型名不透传给 API
    const reqMode = args.mode;

    const taskManagerAdapter: AsyncAgentTaskManager | undefined = ctx.taskManager
      ? {
          appendMessage: (id, m) => ctx.taskManager!.appendMessage(id, m),
          updateSummary: (id, s) => ctx.taskManager!.updateSummary(id, s),
          update: (id, patch) => ctx.taskManager!.update(id, patch),
        }
      : undefined;

    // 单个子任务:派发一个子代理,返回最终文本(或后台/转后台提示)。
    const runOne = async (t: string): Promise<string> => {
      const agentId = randomAgentId();
      const shouldRunAsync = !!args.background || !!agentDef.background;

      let worktree: { root: string; branch: string; cleanup: () => void; hasChanges: () => boolean; hasUnpushedCommits: () => boolean } | undefined;
      // isolation: worktree 和 remote 都创建 git worktree(隔离的工作副本)。
      // remote 的终极形态是 headless 子进程(独立进程隔离),但当前阶段与 worktree 等价。
      if ((isolate || isRemote) && ctx.createWorktree) {
        const wt = ctx.createWorktree!(`a${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`);
        if (wt) worktree = wt;
      }

      const promptMessages: ChatMessage[] = fork ? [] : [{ role: "user", content: t }];
      const forkContextMessages = fork
        ? buildForkContextMessages(ctx.forkMessages ?? [], `[fork 子任务:只做这件事并返回结论,不要改动主任务状态] ${t}`)
        : undefined;
      const resolvedModelForDisplay = reqModel ?? agentDef.model ?? "deepseek-v4-pro";
      const isBuiltInAgent = agentDef.source === "built-in";

      // ---- 异步(后台)路径 ----
      if (shouldRunAsync) {
        if (!ctx.taskManager || !taskManagerAdapter) return "当前环境不支持后台子代理。";
        const bg = ctx.taskManager.registerAsyncAgent({ agentId, description: t.slice(0, 50) });
        void runAsyncAgentLifecycle({
          taskId: bg.agentId,
          agentId,
          agentType: agentDef.agentType,
          isBuiltInAgent,
          prompt: t,
          model: resolvedModelForDisplay,
          makeStream: (onCacheSafeParams) => runAgent({
            agentDef, promptMessages, forkContextMessages, useExactTools: fork,
            isAsync: true, override: { abortController: bg.abortController, agentId },
            worktreePath: worktree?.root, model: reqModel, mode: reqMode, onCacheSafeParams,
            messageParent: (m) => { ctx.taskManager!.emitFromTask(bg.agentId, m); },
          }),
          taskManager: taskManagerAdapter,
          classifyFn: ctx.handoffClassifyFn,
          permissionMode: ctx.permissionMode,
          abortSignal: bg.abortController.signal,
        });
        return `已后台启动子代理${type ? `(类型 ${type})` : ""}(${bg.agentId});完成后会自动通知你结果。你可以先继续别的事或结束本轮。`;
      }

      // ---- 同步路径:前台就是前台,同步等到跑完,不会被任何计时器悄悄转后台 ----
      // (isolate 走下面的兜底路径,同样恒同步跑完——两条路径现在语义一致,isolate 只是多一层 worktree 隔离)。
      // 需要不阻塞就在派发时显式传 background:true;真要中途打断一个跑太久的前台调用,用户自己 ESC。
      if (!isolate && ctx.taskManager && taskManagerAdapter) {
        // abortController 由 registerAgentForeground 建好返回(而非 runAgent 内部私建)——这样它才能
        // 同时注册进 taskManager,让 cancel()/TaskSend/TaskStop 对这个还在跑的子代理真正生效(不止翻状态位)。
        const fg = ctx.taskManager.registerAgentForeground({ agentId, description: t.slice(0, 50) });
        const { abortController } = fg;
        // 父信号链自己管(不让 runAgent 内部兜底链):父 ESC 时要能中止这个还在跑的前台子代理;
        // 正常/异常收尾都要显式解绑,否则监听器永远挂在父的 signal 上(父 signal 贯穿整个会话、被反复复用)。
        let detachParentAbort: (() => void) | undefined;
        if (ctx.signal) {
          if (ctx.signal.aborted) abortController.abort();
          else {
            const onParentAbort = () => abortController.abort();
            const parentSignal = ctx.signal;
            parentSignal.addEventListener("abort", onParentAbort, { once: true });
            detachParentAbort = () => parentSignal.removeEventListener("abort", onParentAbort);
          }
        }

        // Ctrl+B 转后台:注册一个"转后台信号"——收到信号时不再消费生成器,转走处理。
        // 跟父 abort(上面那条)是两回事:父 abort 是"整回合都不要了、直接中止抛错";
        // 这里是"这一步不想再等了,但要让它在后台继续跑完,而不是白白作废"。
        let requestConvert: (() => void) | undefined;
        const convertSignal = new Promise<void>((resolve) => { requestConvert = resolve; });
        const registry: ForegroundRegistry | undefined = ctx.foregroundRegistry;
        registry?.register(agentId, () => requestConvert?.());

        const messages: ChatMessage[] = [];
        const gen = runAgent({
          agentDef, promptMessages, forkContextMessages, useExactTools: fork,
          isAsync: false, override: { agentId, abortController }, worktreePath: worktree?.root, model: reqModel, mode: reqMode,
          messageParent: (m) => { ctx.taskManager!.emitFromTask(fg.taskId, m); },
        });
        try {
          let converted = false;
          while (true) {
            const outcome = await Promise.race([
              gen.next().then((r) => ({ kind: "next" as const, r })),
              convertSignal.then(() => ({ kind: "convert" as const })),
            ]);
            if (outcome.kind === "convert") { converted = true; break; }
            if (outcome.r.done) break;
            messages.push(outcome.r.value);
          }
          registry?.unregister(agentId);

          if (converted) {
            // 先 abort:子代理这一刻如果正卡在自己的某次嵌套前台调用(比如它自己在跑一个 Bash
            // 命令),不 abort 的话那个嵌套调用会继续实际执行、继续计费,只是没人再读结果。
            abortController.abort();
            // 再 await(带超时保护)让生成器走完自己的 finally(注销 hooks、关 MCP 连接、摘监听器)。
            await Promise.race([
              gen.return(undefined),
              new Promise((resolve) => setTimeout(resolve, 5000)),
            ]);
            detachParentAbort?.();
            ctx.taskManager.settle(fg.taskId); // 前台生命周期结束,交棒给下面新起的异步任务

            const newAgentId = randomAgentId();
            const bg = ctx.taskManager.registerAsyncAgent({ agentId: newAgentId, description: t.slice(0, 50) });
            void runAsyncAgentLifecycle({
              taskId: bg.agentId,
              agentId: newAgentId,
              agentType: agentDef.agentType,
              isBuiltInAgent,
              prompt: t,
              model: resolvedModelForDisplay,
              // 复用已产出的 messages 当 forkContextMessages(不能当 promptMessages——那样会在
              // messages 里已经含有的 system 消息前面再叠一条新的 system 消息)。promptMessages
              // 传空数组;worktree/model/mode/fork 这些原调用参数原样复用,否则会跑错目录或让
              // fork 的前缀缓存对不齐。
              makeStream: (onCacheSafeParams) => runAgent({
                agentDef, promptMessages: [], forkContextMessages: messages, useExactTools: fork,
                isAsync: true, override: { abortController: bg.abortController, agentId: newAgentId },
                worktreePath: worktree?.root, model: reqModel, mode: reqMode, onCacheSafeParams,
                messageParent: (m) => { ctx.taskManager!.emitFromTask(bg.agentId, m); },
              }),
              taskManager: taskManagerAdapter,
              classifyFn: ctx.handoffClassifyFn,
              permissionMode: ctx.permissionMode,
              abortSignal: bg.abortController.signal,
            });
            return `已转后台(${bg.agentId});完成后会自动通知你结果。你可以先继续别的事或结束本轮。`;
          }

          detachParentAbort?.(); // 正常跑完:摘掉父信号监听器,不留在父 signal 上等永远不会来的 abort
          ctx.taskManager.settle(fg.taskId); // running -> completed,别让 cancelAll()/TaskStop 把跑完的任务当成还在跑
          const result = finalizeAgentTool(messages, agentId, {
            prompt: t, model: resolvedModelForDisplay, agentType: agentDef.agentType, startTime: Date.now(), isAsync: false, isBuiltInAgent,
          });
          let text = result.content.map((c) => c.text).join("\n") || "(子代理无最终输出)";
          // auto 模式 handoff 安全审查
          if (ctx.handoffClassifyFn && ctx.permissionMode) {
            const warning = await classifyHandoffIfNeeded({
              agentMessages: [...promptMessages, ...messages], permissionMode: ctx.permissionMode,
              abortSignal: new AbortController().signal, subagentType: agentDef.agentType,
              totalToolUseCount: result.totalToolUseCount, classifyFn: ctx.handoffClassifyFn,
            });
            if (warning) text = `${warning}\n\n${text}`;
          }
          return finishWithWorktree(text, worktree);
        } catch (e) {
          // 异常路径同样要收尾:不摘监听器会漏在父 signal 上;不 settle 的话这个任务会在
          // taskManager 里永远挂着 "running"(错误已经作为异常同步抛给父代理,不需要再入队通知)。
          registry?.unregister(agentId);
          detachParentAbort?.();
          ctx.taskManager.settle(fg.taskId, "failed");
          throw e;
        }
      }

      // ---- 兜底路径:无 taskManager(极简测试环境)或 isolate——直接跑完,不做后台切换 ----
      const messages: ChatMessage[] = [];
      for await (const m of runAgent({
        agentDef, promptMessages, forkContextMessages, useExactTools: fork,
        isAsync: false, override: { agentId }, worktreePath: worktree?.root, model: reqModel, mode: reqMode,
      })) messages.push(m);
      const result = finalizeAgentTool(messages, agentId, {
        prompt: t, model: resolvedModelForDisplay, agentType: agentDef.agentType, startTime: Date.now(), isAsync: false, isBuiltInAgent,
      });
      let text = result.content.map((c) => c.text).join("\n") || "(子代理无最终输出)";
      // auto 模式 handoff 安全审查
      if (ctx.handoffClassifyFn && ctx.permissionMode) {
        const warning = await classifyHandoffIfNeeded({
          agentMessages: [...promptMessages, ...messages], permissionMode: ctx.permissionMode,
          abortSignal: new AbortController().signal, subagentType: agentDef.agentType,
          totalToolUseCount: result.totalToolUseCount, classifyFn: ctx.handoffClassifyFn,
        });
        if (warning) text = `${warning}\n\n${text}`;
      }
      return finishWithWorktree(text, worktree);
    };

    const tasks = args.tasks?.length ? args.tasks : args.task ? [args.task] : [];
    if (tasks.length === 0) return "请提供 task 或 tasks。";
    if (tasks.length === 1) return runOne(tasks[0]!);

    // 并行 scatter-gather + 并发限流:最多 MAX_PARALLEL 个同时跑、其余排队,避免一口气打满
    // API 连接/worktree/进程/成本。单个失败不影响其余,结果按原顺序汇总。
    const MAX_PARALLEL = Number(process.env.DAO_MAX_PARALLEL_AGENTS) || 10;
    const results: string[] = new Array(tasks.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < tasks.length) {
        const i = next++;
        const t = tasks[i]!;
        try {
          results[i] = `### 子代理 ${i + 1}/${tasks.length}\n任务:${t}\n\n${await runOne(t)}`;
        } catch (e) {
          results[i] = `### 子代理 ${i + 1}/${tasks.length}\n任务:${t}\n\n[失败] ${e instanceof Error ? e.message : String(e)}`;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, tasks.length) }, worker));
    return results.join("\n\n---\n\n");
  },
});

// P2-48 清理策略(参考):isolate 有改动 → 保留分支供 review/merge;无改动 → 自动删,不留垃圾 worktree。
// 两种都算"有改动":hasChanges(未提交)和 hasUnpushedCommits(子代理自己在 worktree 里commit
// 过、工作区已经变干净,hasChanges 单独看不出来)——只查前者会把"已提交"误判成"无改动",
// 直接 cleanup() 把刚提交的工作连着分支一起删掉。
function finishWithWorktree(text: string, worktree?: { branch: string; cleanup: () => void; hasChanges: () => boolean; hasUnpushedCommits: () => boolean }): string {
  if (!worktree) return text;
  if (worktree.hasChanges() || worktree.hasUnpushedCommits()) return `${text}\n[隔离:改动在分支 ${worktree.branch}(已保留,可 review/merge)]`;
  worktree.cleanup();
  return text;
}
