import { dispatchCommand } from "./commands/commands.js";
import type { Session } from "./session/session.js";
import type { Provider } from "./config/profiles.js";

export interface ReplDeps {
  session: Session;
  // 读一行用户输入;EOF 返回 null。
  readLine: () => Promise<string | null>;
  // 在 session 上跑一个回合(由 index 绑定真实依赖)。
  runTurn: () => Promise<void>;
  // 执行一次压缩(由 index 绑定:压缩 session.messages 并打印结果)。
  compact: () => Promise<void>;
  write: (s: string) => void;
  // UserPromptSubmit 钩子裁决(由 index 绑定;省略=不裁决):
  // blocked 则跳过本回合;additionalContext 作上下文注入。在每个真实提示入回合前调用。
  gateUserPrompt?: (text: string) => Promise<{ blocked: boolean; reason?: string; additionalContext?: string }>;
  // 取出待注入的后台任务通知/子代理 mid-run 消息(由 index 绑定 taskManager.drainNotifications)。
  // 省略 = 不处理后台通知(行为同旧版)。
  drainNotifications?: () => string[];
  // 还有多少后台进程/子代理在跑(由 index 绑定 taskManager.running().length + processManager.runningCount())。
  // 省略 = 不等待(行为同旧版:drainNotifications 一旦为空就直接返回)。
  //
  // 存在的原因:模型收到"后台完成会自动通知你,结束本轮等着"这类工具描述/系统提示词后,
  // 会以纯文本(无 tool_calls)结束当前回合来"让出"控制权等通知。但 drainNotifications 只
  // 排空【已经入队】的通知——后台进程还没退出时它是空的,若这里不主动等,调用方(尤其是
  // headless/--eval 这类一次性会话,没有下一次真实用户输入来触发新回合)就会直接判定"没有
  // 更多事要做"而退出整个进程,那句"自动通知"的承诺永远不会兑现,后台进程虽然靠 detached+
  // unref 继续独立跑着,但已经没有 DAO 进程在收它的结果了。真实撞见:terminal-bench flash
  // 赛道 5 道题(hf-model-inference/compile-compcert/torch-pipeline-parallelism/
  // financial-document-processor/mcmc-sampling-stan)都是这个模式——模型如实做了"结束本轮
  // 等通知"这个被文档教导的动作,DAO 却没有真的等。
  runningBackgroundCount?: () => number;
  // 事件驱动等待:返回一个"下次后台状态变化时才 resolve"的 promise(由 index 绑定
  // taskManager.onChange/processManager.onChange)。提供了就优先用它——真正的完成检测
  // 本来就是事件驱动的(child.on("exit") 直接触发,不是谁在轮询进程状态),这里只是把
  // "查询结果何时被取走"也做成事件驱动,避免固定间隔轮询带来的"最多 2 秒"响应延迟。
  // 省略 = 退回 sleep 轮询(向后兼容,见 sleep 字段)。
  waitForBackgroundChange?: () => Promise<void>;
  // 等待后台进程时的轮询间隔(仅在未提供 waitForBackgroundChange 时生效;测试用来注入假
  // sleep,避免真的等几秒);省略 = 真实 setTimeout。
  sleep?: (ms: number) => Promise<void>;
  // 真实用户消息入回合前回调(由 index 绑定 replyChallenge.onUserMessage;省略=不处理)。
  onUserMessage?: (text: string) => void;
  // 当前生效 provider 的实时读取(/model 按 provider 校验/循环用);省略 = 按 deepseek 处理。
  getProvider?: () => Provider;
}

const BACKGROUND_POLL_MS = 2000;

// 只依赖排空/续跑真正需要的那几个字段(不是完整 ReplDeps)——argvPrompt 一次性路径没有
// readLine/compact 这类只属于交互式多行 REPL 的概念,不该被强迫提供。
export type DrainAndContinueDeps = Pick<ReplDeps, "session" | "write" | "runTurn" | "drainNotifications" | "runningBackgroundCount" | "waitForBackgroundChange" | "sleep">;

export async function drainAndContinue(deps: DrainAndContinueDeps): Promise<void> {
  if (!deps.drainNotifications) return;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (;;) {
    const notes = deps.drainNotifications();
    if (notes.length > 0) {
      deps.write(`↩ 收到 ${notes.length} 个后台任务结果,继续处理…\n`);
      deps.session.addUser(notes.join("\n\n"));
      await deps.runTurn();
      continue; // 处理完这批,可能又产生了新的后台任务/通知,回头再查一次
    }
    // 没有排到通知——如果还有后台进程/子代理没跑完,说明结果还没到,不能当成"没有更多事"
    // 就此返回(调用方可能直接退出整个会话);等它变化再查,直到确实没有在跑的了。
    // 这里到上面 drainNotifications() 之间没有任何 await——同一个事件循环 tick 内,后台
    // 进程的 exit 回调不可能插进来抢先跑,所以"查询为空"和"注册下一次变化监听"之间不存在
    // 取件窗口,不会错过一次通知(错过的另一半保障见 process_manager.ts:child.on("exit")
    // 本身先把结果推进 notifications 数组、再触发 notify()——真正丢数据的路径不存在,
    // 只有"何时被取走"这一层延迟,而这层延迟正是这里要消除的)。
    if (!deps.runningBackgroundCount || deps.runningBackgroundCount() === 0) return;
    if (deps.waitForBackgroundChange) await deps.waitForBackgroundChange();
    else await sleep(BACKGROUND_POLL_MS);
  }
}

export async function runRepl(deps: ReplDeps): Promise<void> {
  for (;;) {
    const line = await deps.readLine();
    if (line === null) return; // EOF
    const cmd = dispatchCommand(line, deps.session, deps.getProvider?.());
    if (cmd.handled) {
      if (cmd.compact) {
        await deps.compact();
        continue;
      }
      if (cmd.output) deps.write(cmd.output + "\n");
      if (cmd.exit) return;
      continue;
    }
    if (!line.trim()) continue;
    if (deps.gateUserPrompt) {
      const up = await deps.gateUserPrompt(line);
      if (up.blocked) { deps.write(`[提交被 hook 阻止] ${up.reason || ""}\n`); continue; }
      deps.session.addUser(line);
      if (up.additionalContext) deps.session.messages.push({ role: "system", content: `[hook 注入的上下文]\n${up.additionalContext}` });
    } else {
      deps.session.addUser(line);
    }
    deps.onUserMessage?.(line); // 路径①:命中相似度门则异步唤起审视者(非阻塞)
    await deps.runTurn();
    // 回合边界:把后台任务完成/子代理 mid-run 消息作为新回合自动续跑,直到排空(零副作用:无通知则不动)。
    await drainAndContinue(deps);
  }
}
