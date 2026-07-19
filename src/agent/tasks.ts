// 后台任务管理器 + 通知队列:让子代理可异步后台跑,主循环不阻塞;完成后把结果作为
// <task-notification> 入队,主循环在后续回合注入给模型(CC 的异步任务 + 消息队列模型)。

import type { ChatMessage } from "../client/types.js";

export interface BgTask {
  id: string;
  description: string;
  status: "running" | "completed" | "failed" | "canceled";
  result?: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
  // 新增:进度/摘要/agent 类型
  summary?: string;
  messages?: ChatMessage[];
  agentType?: string;
}

export interface TaskManager {
  // 后台启动一个任务(run 收到 signal 与自身 id),立即返回 task id。
  launch(description: string, run: (signal: AbortSignal, id: string) => Promise<string>): string;
  // 接管一个已在运行的 promise,交给 TaskManager 追踪:完成/失败时入队通知。不可取消。
  adopt(description: string, promise: Promise<string>): string;
  // 手动建一个任务(不背靠任何 promise/进程)——纯状态追踪,配合 update() 手动推进。
  create(description: string): string;
  // 手动更新一个任务(仅对 create() 建的、或已结束的任务生效;运行中的 launch/adopt 任务由 promise 驱动,
  // 不接受手动改 status,防止和自动结算打架——但 description 任何时候都能改)。
  // status 改为 completed/failed 时,和 promise 结算路径一样入队 <task-notification>。
  update(id: string, patch: { status?: "completed" | "failed" | "canceled"; result?: string; description?: string }): boolean;
  // 前台任务在"没有转后台、正常跑完"这条路径上结算:running -> completed,但不入队 <task-notification>
  // (结果已经作为工具调用本身的返回值同步交给父代理了,再入队会在下一回合边界重复投递同一个结果)。
  // 只做状态收尾,好让 cancelAll()/TaskStop 别把一个早就跑完的前台任务当成还在运行的任务去"中止"。
  // status 默认 completed;runOne 内部抛错时传 "failed" 结算(错误本身已经作为异常同步抛给父代理)。
  settle(id: string, status?: "completed" | "failed"): boolean;
  // 给运行中的任务追加一条消息(SendMessage),由其在下一个工具回合边界消费。
  send(id: string, message: string): boolean;
  // 运行中任务给父代理发一条 mid-run 消息(进度/发现/提问):入通知队列 + 触发 onChange。
  emitFromTask(id: string, message: string): boolean;
  // 取出并清空某任务的待消费消息(子代理 runTurn 在回合边界调用)。
  drainPending(id: string): string[];
  drainNotifications(): string[]; // 取出并清空待通知(已完成/失败任务的 XML 通知)
  hasPending(): boolean;
  running(): BgTask[];
  all(): BgTask[]; // 全部任务(含已结束),供 TaskList 工具查询历史
  get(id: string): BgTask | undefined;
  cancel(id: string): boolean;
  cancelAll(): void;
  onChange(cb: () => void): void; // 任务状态变化(启动/完成/失败/取消)时回调,驱动 UI 刷新与通知处理
  // 前台 agent 注册。taskId 恒等于 agentId(与 registerAsyncAgent 用同一套 id 空间)——此前这里
  // 另起一个 task-N 计数器,和子代理自己的 agentId 是两套不相干的 id,导致 TaskSend/cancel 用
  // task-N 发消息,而子代理的 drainPending 却用 agentId 去读,两边永远对不上号,消息发了等于没发。
  // 内部自建 abortController 并随结果返回(与 registerAsyncAgent 同一套写法)——调用方不用自己
  // new 一个再传进来,这样 cancel()/TaskStop 才能真正中止这个还在跑的子代理,而不是只翻状态位。
  // 前台就是前台:同步等到它跑完,不会被任何计时器悄悄转后台——需要后台就在派发时显式声明
  // (Agent 工具的 background 参数),真要中途打断一个跑太久的前台调用,用户自己 ESC。
  registerAgentForeground(opts: { agentId: string; description: string }): { taskId: string; abortController: AbortController };
  // 新增:后台 agent 注册(独立 AbortController)
  registerAsyncAgent(opts: { agentId: string; description: string }): { agentId: string; abortController: AbortController };
  // 新增:更新任务摘要
  updateSummary(taskId: string, summary: string): boolean;
  // 新增:追加消息到任务的实时消息列表
  appendMessage(taskId: string, message: ChatMessage): boolean;
}

// 转义注入文本里的 XML 元字符:description/result/message 来自用户任务或子代理输出,
// 可能含 < > &(甚至字面 </message>),不转义会破坏父代理对通知块的解析。
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function notificationXml(t: BgTask): string {
  const body = t.status === "completed" ? (t.result ?? "") : (t.error ?? "");
  return [
    `<task-notification>`,
    `<task-id>${t.id}</task-id>`,
    `<description>${escapeXml(t.description)}</description>`,
    `<status>${t.status}</status>`,
    `<result>`,
    escapeXml(body),
    `</result>`,
    `</task-notification>`,
  ].join("\n");
}

function taskMessageXml(t: BgTask, message: string): string {
  return [
    `<task-message>`,
    `<task-id>${t.id}</task-id>`,
    `<description>${escapeXml(t.description)}</description>`,
    `<message>`,
    escapeXml(message),
    `</message>`,
    `</task-message>`,
  ].join("\n");
}

export function createTaskManager(): TaskManager {
  const tasks = new Map<string, BgTask>();
  const controllers = new Map<string, AbortController>();
  const pending = new Map<string, string[]>(); // 各任务待消费消息(SendMessage)
  const notifications: string[] = [];
  let counter = 0;
  let onChangeCb: (() => void) | undefined;
  const notify = () => onChangeCb?.();

  const cancelOne = (id: string): boolean => {
    const t = tasks.get(id);
    if (!t || t.status !== "running") return false;
    const ac = controllers.get(id);
    ac?.abort(); // 手动建的任务(create())没有 controller,无进程可 abort,仍走下面的状态转移
    t.status = "canceled";
    t.endedAt = Date.now();
    notify();
    return true;
  };

  return {
    launch(description, run) {
      const id = `task-${++counter}`;
      const ac = new AbortController();
      const t: BgTask = { id, description, status: "running", startedAt: Date.now() };
      tasks.set(id, t);
      controllers.set(id, ac);
      notify();
      run(ac.signal, id).then(
        (result) => {
          if (t.status !== "running") return; // 已被取消
          t.status = "completed";
          t.result = result;
          t.endedAt = Date.now();
          notifications.push(notificationXml(t));
          notify();
        },
        (e) => {
          if (t.status !== "running") return;
          t.status = "failed";
          t.error = e instanceof Error ? e.message : String(e);
          t.endedAt = Date.now();
          notifications.push(notificationXml(t));
          notify();
        },
      );
      return id;
    },
    adopt(description, promise) {
      const id = `task-${++counter}`;
      const t: BgTask = { id, description, status: "running", startedAt: Date.now() };
      tasks.set(id, t);
      notify();
      promise.then(
        (result) => {
          if (t.status !== "running") return; // 已被 update()/cancel() 手动结束,不再覆盖(补齐与 launch() 一致的防御)
          t.status = "completed";
          t.result = result;
          t.endedAt = Date.now();
          notifications.push(notificationXml(t));
          notify();
        },
        (e) => {
          if (t.status !== "running") return;
          t.status = "failed";
          t.error = e instanceof Error ? e.message : String(e);
          t.endedAt = Date.now();
          notifications.push(notificationXml(t));
          notify();
        },
      );
      return id;
    },
    create(description) {
      const id = `task-${++counter}`;
      const t: BgTask = { id, description, status: "running", startedAt: Date.now() };
      tasks.set(id, t);
      notify();
      return id;
    },
    update(id, patch) {
      const t = tasks.get(id);
      if (!t) return false;
      if (patch.description !== undefined) t.description = patch.description;
      if (patch.status !== undefined) {
        if (t.status !== "running") return false; // 已结束的任务不可再改状态(防止和自动结算的通知重复)
        t.status = patch.status;
        t.endedAt = Date.now();
        if (patch.result !== undefined) {
          if (t.status === "completed") t.result = patch.result;
          else t.error = patch.result;
        }
        notifications.push(notificationXml(t));
      }
      notify();
      return true;
    },
    settle(id, status = "completed") {
      const t = tasks.get(id);
      if (!t || t.status !== "running") return false;
      t.status = status;
      t.endedAt = Date.now();
      notify();
      return true;
    },
    send(id, message) {
      const t = tasks.get(id);
      if (!t || t.status !== "running") return false;
      (pending.get(id) ?? pending.set(id, []).get(id)!).push(message);
      return true;
    },
    emitFromTask(id, message) {
      const t = tasks.get(id);
      if (!t || t.status !== "running") return false;
      notifications.push(taskMessageXml(t, message));
      notify();
      return true;
    },
    drainPending(id) {
      const q = pending.get(id);
      if (!q || q.length === 0) return [];
      pending.set(id, []);
      return q;
    },
    drainNotifications() {
      return notifications.splice(0);
    },
    hasPending() {
      return notifications.length > 0;
    },
    running() {
      return [...tasks.values()].filter((t) => t.status === "running");
    },
    all() {
      return [...tasks.values()];
    },
    get(id) {
      return tasks.get(id);
    },
    cancel: cancelOne,
    cancelAll() {
      for (const id of controllers.keys()) cancelOne(id);
    },
    onChange(cb) {
      onChangeCb = cb;
    },
    registerAgentForeground(opts) {
      const id = opts.agentId;
      const ac = new AbortController();
      tasks.set(id, { id, description: opts.description, status: "running", startedAt: Date.now() });
      controllers.set(id, ac);
      notify();
      return { taskId: id, abortController: ac };
    },
    registerAsyncAgent(opts) {
      const id = opts.agentId;
      const ac = new AbortController();
      tasks.set(id, { id, description: opts.description, status: "running", startedAt: Date.now() });
      controllers.set(id, ac);
      notify();
      return { agentId: id, abortController: ac };
    },
    updateSummary(taskId, summary) {
      const t = tasks.get(taskId);
      if (!t) return false;
      t.summary = summary;
      notify();
      return true;
    },
    appendMessage(taskId, message) {
      const t = tasks.get(taskId);
      if (!t) return false;
      if (!t.messages) t.messages = [];
      t.messages.push(message);
      return true;
    },
  };
}
