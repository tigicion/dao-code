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

let exitHookInstalled = false;
/** 注册退出时 flush(幂等)。flush 最多等 2s,超时放弃,绝不卡退出。 */
export function registerExitFlush(flush: () => Promise<void>): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const run = () => {
    void Promise.race([
      flush(),
      new Promise((r) => setTimeout(r, 2000)),
    ]).catch(() => {});
  };
  process.on("exit", run);
  process.on("SIGINT", run);
  process.on("SIGTERM", run);
}
