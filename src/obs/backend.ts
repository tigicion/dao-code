export interface ObsSpan {
  setAttributes(attrs: Record<string, unknown>): void;
  end(): void;
}

export interface ObsBackend {
  startSpan(opts: {
    name: string;
    spanType: "LLM" | "TOOL" | "DEFAULT";
    input?: unknown;
    sessionId?: string;
    metadata?: Record<string, unknown>;
  }): ObsSpan;
  /** 让 span 成为活跃父上下文,fn 执行期间新建的 span 都挂它下面。 */
  withActive<T>(span: ObsSpan, fn: () => T): T;
  /** trace 级事件(异常信号):挂到当前活跃 trace,供 SQL/dashboard 聚合。 */
  event(name: string, attributes?: Record<string, string | number | boolean>): void;
  flush(): Promise<void>;
}

let backend: ObsBackend | null = null;

export function setBackend(b: ObsBackend | null): void {
  backend = b;
}
export function getBackend(): ObsBackend | null {
  return backend;
}
export function isObsOn(): boolean {
  return backend !== null;
}

// 当前会话 id:main() 建 SessionStore 后 set 一次,wrapRunTurn 用它给 turn span 打 session_id
// (TurnDeps 无 sessionId 字段,故走这条独立通道,让 trace 可按 session 分组/查找)。
let sessionId: string | undefined;
export function setObsSession(id: string | undefined): void {
  sessionId = id;
}
export function getObsSession(): string | undefined {
  return sessionId;
}

// 全局 trace metadata:进程级不变量(如 dao 版本号),main() 启动时 set 一次,
// wrapRunTurn 合进 turn span 的 metadata → 落到 trace 级,可按版本等维度过滤。
let obsMeta: Record<string, unknown> = {};
export function setObsMeta(meta: Record<string, unknown>): void {
  obsMeta = { ...obsMeta, ...meta };
}
export function getObsMeta(): Record<string, unknown> {
  return obsMeta;
}

// 观测状态(供 /status 与欢迎屏显示,让交互模式下"开没开/降级没"可见)。
export interface ObsStatus {
  requested: boolean; // 是否带了 --obs
  on: boolean; // 是否真初始化成功(未降级)
  endpoint?: string; // 上报地址(如 localhost:8001)
}
let statusReq = false;
let statusEndpoint: string | undefined;
export function setObsStatus(s: { requested?: boolean; endpoint?: string }): void {
  if (s.requested !== undefined) statusReq = s.requested;
  if (s.endpoint !== undefined) statusEndpoint = s.endpoint;
}
export function obsStatus(): ObsStatus {
  return { requested: statusReq, on: isObsOn(), endpoint: statusEndpoint };
}

/** 退出前 flush 当前 backend(旁路铁律):
 *  - 未开观测(getBackend() 为 null)→ 立即 resolve、零延迟、不 import lmnr;
 *  - 已开 → flush 与超时竞速,最多等 timeoutMs(默认 2s),超时放弃;
 *  - 任何错误一律吞掉,绝不上抛、绝不卡退出。 */
export function flushObs(timeoutMs = 2000): Promise<void> {
  const b = getBackend();
  if (!b) return Promise.resolve();
  return Promise.race([
    b.flush(),
    new Promise<void>((r) => setTimeout(r, timeoutMs)),
  ]).catch(() => {});
}
