// 后台任务管理器 + 通知队列:让子代理可异步后台跑,主循环不阻塞;完成后把结果作为
// <task-notification> 入队,主循环在后续回合注入给模型(CC 的异步任务 + 消息队列模型)。

export interface BgTask {
  id: string;
  description: string;
  status: "running" | "completed" | "failed" | "canceled";
  result?: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export interface TaskManager {
  // 后台启动一个任务(run 收到 signal 与自身 id),立即返回 task id。
  launch(description: string, run: (signal: AbortSignal, id: string) => Promise<string>): string;
  // 接管一个已在运行的 promise(前台超时自动转后台用):完成/失败时入队通知。不可取消。
  adopt(description: string, promise: Promise<string>): string;
  // 给运行中的任务追加一条消息(SendMessage),由其在下一个工具回合边界消费。
  send(id: string, message: string): boolean;
  // 运行中任务给父代理发一条 mid-run 消息(进度/发现/提问):入通知队列 + 触发 onChange。
  emitFromTask(id: string, message: string): boolean;
  // 取出并清空某任务的待消费消息(子代理 runTurn 在回合边界调用)。
  drainPending(id: string): string[];
  drainNotifications(): string[]; // 取出并清空待通知(已完成/失败任务的 XML 通知)
  hasPending(): boolean;
  running(): BgTask[];
  get(id: string): BgTask | undefined;
  cancel(id: string): boolean;
  cancelAll(): void;
  onChange(cb: () => void): void; // 任务状态变化(启动/完成/失败/取消)时回调,驱动 UI 刷新与通知处理
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
    const ac = controllers.get(id);
    const t = tasks.get(id);
    if (!ac || !t || t.status !== "running") return false;
    ac.abort();
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
          t.status = "completed";
          t.result = result;
          t.endedAt = Date.now();
          notifications.push(notificationXml(t));
          notify();
        },
        (e) => {
          t.status = "failed";
          t.error = e instanceof Error ? e.message : String(e);
          t.endedAt = Date.now();
          notifications.push(notificationXml(t));
          notify();
        },
      );
      return id;
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
  };
}
