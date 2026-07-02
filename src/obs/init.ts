import { setBackend, registerExitFlush, type ObsBackend, type ObsSpan } from "./backend.js";

/** 开启观测:动态 import Laminar、初始化、装配 ObsBackend 适配器、注册退出 flush。
 *  失败一律降级为「未开启」,绝不影响主链路。 */
export async function initObs(on: boolean): Promise<void> {
  if (!on) return; // 关闭:不 import lmnr,零开销
  try {
    // optionalDependency:未安装时动态 import 抛错,由 catch 兜底降级为关闭
    const { Laminar } = await import("@lmnr-ai/lmnr");
    Laminar.initialize({
      projectApiKey: process.env.LMNR_PROJECT_API_KEY,
      baseUrl: process.env.LMNR_BASE_URL ?? "http://localhost",
      httpPort: Number(process.env.LMNR_HTTP_PORT) || 8000,
      grpcPort: Number(process.env.LMNR_GRPC_PORT) || 8001,
    });
    const backend: ObsBackend = {
      startSpan(o) {
        const span = Laminar.startSpan({
          name: o.name, input: o.input, spanType: o.spanType,
          sessionId: o.sessionId, metadata: o.metadata,
        });
        const obs: ObsSpan = {
          setAttributes: (a) => span.setAttributes(a as Record<string, string | number>),
          end: () => span.end(),
        };
        return obs;
      },
      withActive: (span, fn) => {
        // ObsSpan 是适配壳;真实 withSpan 需要底层 Laminar Span。见下方说明。
        return fn();
      },
      flush: () => Laminar.flush(),
    };
    setBackend(backend);
    registerExitFlush(() => Laminar.flush());
    if (!process.env.LMNR_PROJECT_API_KEY) {
      process.stderr.write("[obs] 已开启但未设 LMNR_PROJECT_API_KEY,trace 可能无法入库\n");
    }
  } catch (e) {
    process.stderr.write(`[obs] 初始化失败,已降级为关闭:${(e as Error).message}\n`);
    // 不 setBackend → isObsOn() 仍为 false → 包装器全透传
  }
}
