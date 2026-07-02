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
