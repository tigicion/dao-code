import { z } from "zod";
import { defineTool } from "./types.js";
import type { ChatMessage } from "../client/types.js";
import type { AgentDef } from "../agent/agent_defs.js";
import { FORK_AGENT, buildForkContextMessages } from "../agent/fork_agent.js";
import { finalizeAgentTool } from "../agent/agent_tools.js";
import { runAsyncAgentLifecycle, type AsyncAgentTaskManager } from "../agent/agent_lifecycle.js";

// 子代理模型名归一化:模型常把 "deepseek-v4-pro" 写成 "deepseek-v4"/"pro"/"flash" → raw 传 API 会失败。
// 含 flash/pro 的归到对应全名;已是有效全名保留;其余(如裸 "deepseek-v4")→ undefined(继承父模型),
// 绝不把无效名透传给 API(实测一次子代理派发因 "deepseek-v4" 失败)。
export function normalizeModel(m: string | undefined): string | undefined {
  if (!m) return undefined;
  const s = m.trim().toLowerCase();
  if (s === "deepseek-v4-pro" || s === "deepseek-v4-flash") return s;
  if (s.includes("flash")) return "deepseek-v4-flash";
  if (s.includes("pro")) return "deepseek-v4-pro";
  return undefined; // 无法识别 → 继承父模型,不透传无效名
}

function randomAgentId(): string {
  return `agent-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
}

export const agentTool = defineTool({
  name: "agent",
  description:
    "把独立子任务派发给子代理:它用同样的工具自主跑完、只返回最终结果(你看不到中间过程)。" +
    "任务描述要自包含——子代理没有当前对话上下文。" +
    "传 task 派单个;传 tasks 数组则并行派发多个并汇总(适合可并行的独立调查/分析)。" +
    "并行任务务必彼此独立、互不依赖;需要同时改文件的任务不要并行,以免互相冲突。" +
    "子代理内不能再派子代理(不支持嵌套)。" +
    "单个前台子代理跑超过默认 60 秒会自动转后台(不阻塞你,完成后通知)。" +
    "并行任务默认最多 10 个同时跑,其余排队,不代表真的全部同时执行。\n" +
    "四个可选调用方式互斥、别混用:isolate(独立 git worktree 里改文件,并行改文件不冲突,改动留在分支供你事后 review/merge)、" +
    "fork(继承你当前完整上下文+复用前缀缓存,近乎免费,适合带全量背景做分支尝试)、model(临时换模型,通常为了省钱跑廉价任务," +
    "但换模型本身会让前缀缓存失效,不够便宜的任务不划算)、mode=plan(只读规划模式)。fork 和 model/mode 天生冲突——fork 的" +
    "价值就是复用缓存,换模型/换模式会让这份缓存作废。agent_type 指定自定义子代理类型(有专属 prompt/工具白名单),不给就是通用子代理。" +
    "拿到结果后留个心眼:子代理返回的是它自称做了什么,不是你亲眼确认过的事实——它可能把「应该改好了」当「已经改好了」报回来。" +
    "涉及代码改动、修 bug、跑测试这类子任务,回来后花一次工具调用亲自复核关键结论(读一下实际 diff、跑一下它说过的命令)," +
    "不要原样把子代理的自述转述给用户当作你自己验证过的结论。",
  descriptionEn:
    "Dispatches an independent subtask to a subagent: it runs autonomously with the same tools and returns only the final result (you don't see intermediate steps). " +
    "Task description must be self-contained — the subagent has no current conversation context. " +
    "Pass task for a single dispatch; pass tasks array for parallel dispatch with aggregated results (ideal for parallel independent investigation/analysis). " +
    "Parallel tasks MUST be mutually independent with no dependencies; tasks that modify the same files must not be parallelized to avoid conflicts. " +
    "A subagent cannot dispatch its own subagent (no nesting). " +
    "A single foreground subagent running past a default 60s threshold auto-promotes to background (doesn't block you; notified on completion). " +
    "Parallel tasks run at most 10 concurrently by default — the rest queue, so not all tasks truly run simultaneously.\n" +
    "Four optional dispatch modes are mutually exclusive, don't mix them: isolate (edits happen in an isolated git worktree, safe to parallelize file changes, " +
    "changes are left on a branch for you to review/merge afterward), fork (inherits your full current context + reuses the prefix cache, nearly free — good for a " +
    "branch attempt with full background), model (temporarily switch models, usually to run a cheap task on a cheaper model — but switching itself invalidates the " +
    "prefix cache, not worth it unless the task is cheap enough), mode=plan (read-only planning mode). fork inherently conflicts with model/mode — fork's whole value " +
    "is reusing the cache, and switching model/mode invalidates that cache. agent_type selects a custom subagent type (with its own prompt/tool allowlist); omit for a generic subagent. " +
    "Trust but verify what comes back: a subagent's summary describes what it claims it did, not what you've confirmed happened — it may report \"should be fixed\" as " +
    "\"fixed\". For subtasks touching code changes, bug fixes, or tests, spend one follow-up tool call checking the actual result yourself (read the real diff, run the " +
    "command it says it ran) before reporting the subagent's account to the user as your own verified conclusion.",
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
      .describe("后台运行:立即返回任务 id 不阻塞,完成后结果会自动通知你。适合耗时长、你可同时做别的事的任务。"),
    agent_type: z
      .string()
      .optional()
      .describe("指定自定义子代理类型(见系统 prompt 的'可用子代理类型');省略则用通用子代理。"),
    isolate: z
      .boolean()
      .optional()
      .describe("git worktree 隔离:子代理在独立工作树+分支里改文件,并行改文件互不冲突。改动留在分支供事后 review/merge。"),
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
    const isolate = !fork && !!args.isolate && !!ctx.createWorktree;
    const reqModel = normalizeModel(args.model); // 归一化/兜底:无效模型名不透传给 API
    const reqMode = args.mode;

    const agentDef: AgentDef = fork
      ? FORK_AGENT
      : (agentDefs.find((d) => d.agentType === (type ?? "general-purpose")) ?? FORK_AGENT);

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

      let worktree: { root: string; branch: string; cleanup: () => void; hasChanges: () => boolean } | undefined;
      if (isolate) {
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
          }),
          taskManager: taskManagerAdapter,
        });
        return `已后台启动子代理${type ? `(类型 ${type})` : ""}(${bg.agentId});完成后会自动通知你结果。你可以先继续别的事或结束本轮。`;
      }

      // ---- 同步路径,可中途转后台(isolate 保持恒同步跑完,不参与自动转后台)----
      if (!isolate && ctx.taskManager && taskManagerAdapter) {
        const ms = Number(process.env.DAO_AUTO_BACKGROUND_MS) || 60000;
        const fg = ctx.taskManager.registerAgentForeground({ agentId, description: t.slice(0, 50), autoBackgroundMs: ms });
        const iterator = runAgent({
          agentDef, promptMessages, forkContextMessages, useExactTools: fork,
          isAsync: false, override: { agentId }, worktreePath: worktree?.root, model: reqModel, mode: reqMode,
        })[Symbol.asyncIterator]();

        const messages: ChatMessage[] = [];
        while (true) {
          const raced = await Promise.race([
            iterator.next().then((r) => ({ kind: "msg" as const, r })),
            fg.backgroundSignal.then(() => ({ kind: "bg" as const })),
          ]);
          if (raced.kind === "bg") {
            // 前台->后台无缝切换:复用同一个 iterator 继续消费,不重跑。
            void runAsyncAgentLifecycle({
              taskId: fg.taskId,
              agentId,
              agentType: agentDef.agentType,
              isBuiltInAgent,
              prompt: t,
              model: resolvedModelForDisplay,
              makeStream: () => ({ [Symbol.asyncIterator]: () => iterator }) as AsyncGenerator<ChatMessage, void>,
              taskManager: taskManagerAdapter,
            });
            return `子代理运行超过 ${Math.round(ms / 1000)}s,已自动转入后台(${fg.taskId});完成后会通知你。你可以先继续别的或结束本轮。`;
          }
          if (raced.r.done) break;
          messages.push(raced.r.value);
        }
        fg.cancelAutoBackground();
        const result = finalizeAgentTool(messages, agentId, {
          prompt: t, model: resolvedModelForDisplay, agentType: agentDef.agentType, startTime: Date.now(), isAsync: false, isBuiltInAgent,
        });
        const text = result.content.map((c) => c.text).join("\n") || "(子代理无最终输出)";
        return finishWithWorktree(text, worktree);
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
      const text = result.content.map((c) => c.text).join("\n") || "(子代理无最终输出)";
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

// P2-48 清理策略(对标 CC):isolate 有改动 → 保留分支供 review/merge;无改动 → 自动删,不留垃圾 worktree。
function finishWithWorktree(text: string, worktree?: { branch: string; cleanup: () => void; hasChanges: () => boolean }): string {
  if (!worktree) return text;
  if (worktree.hasChanges()) return `${text}\n[隔离:改动在分支 ${worktree.branch}(已保留,可 review/merge)]`;
  worktree.cleanup();
  return text;
}
