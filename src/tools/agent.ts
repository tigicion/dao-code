import { z } from "zod";
import { defineTool } from "./types.js";

export const agentTool = defineTool({
  name: "agent",
  description:
    "把独立子任务派发给子代理:它用同样的工具自主跑完、只返回最终结果(你看不到中间过程)。" +
    "任务描述要自包含——子代理没有当前对话上下文。" +
    "传 task 派单个;传 tasks 数组则并行派发多个并汇总(适合可并行的独立调查/分析)。" +
    "并行任务务必彼此独立、互不依赖;需要同时改文件的任务不要并行,以免互相冲突。",
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
      .describe("调用级权限模式覆盖:plan=只读规划。省略则继承主会话模式。与 fork 互斥。"),
  }),
  handler: async (args, ctx) => {
    if ((ctx.subagentDepth ?? 0) >= 2) {
      return "已达子代理嵌套上限(2 层):为防递归放大与成本失控,这一层不能再派子代理。请自己完成这件事,或把它拆小后在结论里回报需要继续的部分。";
    }
    if (!ctx.runSubagent) {
      return "当前环境不支持子代理。";
    }
    const type = args.agent_type;
    if (type && ctx.agentTypes && !ctx.agentTypes.some((a) => a.name === type)) {
      const avail = ctx.agentTypes.map((a) => a.name).join(", ") || "(无)";
      return `未知子代理类型「${type}」。可用:${avail}。`;
    }
    if (args.background && (args.model || args.mode)) {
      return "后台子代理暂不支持 model/mode 覆盖(后续版本补)。若要换模型跑后台:去掉 model/mode,或为该用途定义一个带 model 的 agent_type 再用 background。";
    }
    // 后台模式:每个任务后台启动,立即返回 id;完成后经通知队列回灌(主循环不阻塞)。
    if (args.background && ctx.runBackgroundAgent) {
      const list = args.tasks?.length ? args.tasks : args.task ? [args.task] : [];
      if (list.length === 0) return "请提供 task 或 tasks。";
      const ids = list.map((t) => ctx.runBackgroundAgent!(t, type));
      return `已后台启动 ${ids.length} 个子代理${type ? `(类型 ${type})` : ""}(${ids.join(", ")});完成后会自动通知你结果。你可以先继续别的事或结束本轮。`;
    }
    const run = ctx.runSubagent;
    if (args.fork && (args.model || args.mode)) {
      return "fork 与 model/mode 覆盖互斥:fork 的价值是复用父代理的前缀缓存,而换模型/改模式会让该缓存失效、fork 失去意义。请去掉 model/mode,或改用普通子代理(去掉 fork)。";
    }
    const fork = !!args.fork && !!ctx.runForkAgent; // ② fork 优先(继承父上下文 + 复用缓存)
    const isolate = !fork && !!args.isolate && !!ctx.createWorktree;
    // 隔离运行:为该子代理建 worktree,在其中跑;改动留在分支供 review。非 git 仓库则回退共享。
    const runOne = async (t: string): Promise<string> => {
      if (fork) return ctx.runForkAgent!(t, ctx.signal);
      if (isolate) {
        const wt = ctx.createWorktree!(`a${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`);
        if (wt) {
          const r = await run({ task: t, signal: ctx.signal, agentType: type, workspaceRoot: wt.root, model: args.model, mode: args.mode });
          // P2-48 清理策略(对标 CC):有改动→保留分支供 review/merge;无改动→自动删,不留垃圾 worktree。
          if (wt.hasChanges()) return `${r}\n[隔离:改动在分支 ${wt.branch}(已保留,可 review/merge)]`;
          wt.cleanup();
          return r;
        }
      }
      return run({ task: t, signal: ctx.signal, agentType: type, model: args.model, mode: args.mode });
    };
    const tasks = args.tasks?.length ? args.tasks : args.task ? [args.task] : [];
    if (tasks.length === 0) return "请提供 task 或 tasks。";
    // 单个前台子代理:跑超过阈值(默认 60s)自动转后台,主循环不被长子任务一直阻塞。
    if (tasks.length === 1 && !isolate && ctx.adoptBackground) {
      const p = run({ task: tasks[0]!, signal: ctx.signal, agentType: type, model: args.model, mode: args.mode });
      const ms = Number(process.env.DAO_AUTO_BACKGROUND_MS) || 60000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<{ bg: true }>((res) => { timer = setTimeout(() => res({ bg: true }), ms); });
      const raced = await Promise.race([p.then((r) => ({ bg: false as const, r })), timeout]);
      if (timer) clearTimeout(timer);
      if (!raced.bg) return raced.r;
      const id = ctx.adoptBackground(`(自动转后台) ${tasks[0]!.slice(0, 50)}`, p);
      return `子代理运行超过 ${Math.round(ms / 1000)}s,已自动转入后台(${id});完成后会通知你。你可以先继续别的或结束本轮。`;
    }
    if (tasks.length === 1) return runOne(tasks[0]!);

    // 并行 scatter-gather + 并发限流:最多 MAX_PARALLEL 个同时跑、其余排队,避免一口气打满
    // API 连接/worktree/进程/成本。单个失败不影响其余,结果按原顺序汇总。
    // 深度感知并发:depth1 子代理再扇出(→depth2)时收紧到 3,避免 10×10 指数爆;主代理(depth0)用默认 10。
    const depth = ctx.subagentDepth ?? 0;
    const MAX_PARALLEL = depth >= 1 ? 3 : (Number(process.env.DAO_MAX_PARALLEL_AGENTS) || 10);
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
