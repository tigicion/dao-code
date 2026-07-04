import { setBackend, setObsStatus, type ObsBackend, type ObsSpan } from "./backend.js";

/** 开启观测:动态 import Laminar、初始化、装配 ObsBackend 适配器。退出 flush 由组合根在真实退出路径 await flushObs 完成。
 *  失败一律降级为「未开启」,绝不影响主链路。 */
export async function initObs(on: boolean): Promise<void> {
  setObsStatus({ requested: on }); // 记下是否请求了观测(供 /status、欢迎屏显示"降级没")
  if (!on) return; // 关闭:不 import lmnr,零开销
  try {
    // optionalDependency:未安装时动态 import 抛错,由 catch 兜底降级为关闭
    const { Laminar } = await import("@lmnr-ai/lmnr");
    const baseUrl = process.env.LMNR_BASE_URL ?? "http://localhost";
    const grpcPort = Number(process.env.LMNR_GRPC_PORT) || 8001;
    Laminar.initialize({
      projectApiKey: process.env.LMNR_PROJECT_API_KEY,
      baseUrl,
      httpPort: Number(process.env.LMNR_HTTP_PORT) || 8000,
      grpcPort,
    });
    // ObsSpan 是适配壳,不暴露底层 Laminar Span;用 WeakMap 把壳映射回 raw span,
    // 供 withActive 调 Laminar.withSpan 建立父子上下文(壳被回收时映射自动清理)。
    const rawOf = new WeakMap<ObsSpan, ReturnType<typeof Laminar.startSpan>>();
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
        rawOf.set(obs, span);
        return obs;
      },
      withActive: (span, fn) => {
        const raw = rawOf.get(span);
        // 让 raw span 成为活跃父上下文,fn 期间新建的 span 挂它下面;endOnExit=false(由 wrap 的 finally 统一 end)。
        return raw ? Laminar.withSpan(raw, fn, false) : fn();
      },
      flush: () => Laminar.flush(),
    };
    setBackend(backend);
    setObsStatus({ endpoint: `${baseUrl.replace(/^https?:\/\//, "")}:${grpcPort}` });
    if (!process.env.LMNR_PROJECT_API_KEY) {
      process.stderr.write("[obs] 已开启但未设 LMNR_PROJECT_API_KEY,trace 可能无法入库\n");
    }
  } catch (e) {
    process.stderr.write(`[obs] 初始化失败,已降级为关闭:${(e as Error).message}\n`);
    // 不 setBackend → isObsOn() 仍为 false → 包装器全透传
  }
}
