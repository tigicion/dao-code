import type { Provider } from "./profiles.js";
import { DEFAULTS } from "./profiles.js";
import { responsesFetch, usesResponses } from "../client/responses.js";

// 落盘前轻量校验凭证:打 provider 的 /models(最便宜的鉴权请求),确认 key 有效。
// 对标 opencode wizard 的 "runs a model check";避免存了错 key 要到首条消息才炸。
export type ValidateResult =
  | { ok: true }
  | { ok: false; reason: "invalid" } // 401/403:key 无效
  | { ok: false; reason: "unreachable" } // 网络不通
  | { ok: false; reason: "http"; status: number }; // 其它非 2xx

export async function validateCredential(
  cred: { baseUrl: string; key: string; provider?: Provider; model?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ValidateResult> {
  let res: Response;
  try {
    // 给了具体 model(自定义网关选完模型后)或 coding/token-plan 路径(无 /models):都用一发最小 chat
    // 探针判鉴权(max_tokens:1)。自定义网关尤其需要按选中 model 探针——网关 /models 是全量列表,
    // 不代表该 token 都授权了(京东网关未授权模型返回 4012),只有真打一发才能确认这个 model 能跑。
    if (cred.model || cred.provider === "volcengine" || cred.provider === "qianfan" || cred.provider === "zhipu") {
      // 探针模型:给了 model 用 model;否则用该 provider 的默认模型——zhipu coding 端点没有
      // deepseek 系模型,沿用写死的 deepseek-v4-flash 会把有效 key 误判成失败。
      const probeModel = cred.model ?? (cred.provider ? DEFAULTS[cred.provider].model : "deepseek-flash");
      const useResponses = usesResponses(cred.baseUrl, probeModel);
      const probeFetch = useResponses ? responsesFetch(fetchImpl) : fetchImpl;
      res = await probeFetch(`${cred.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cred.key}` },
        body: JSON.stringify({ model: probeModel, messages: [{ role: "user", content: "1" }], max_tokens: useResponses ? 16 : 1 }),
      });
    } else {
      res = await fetchImpl(`${cred.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${cred.key}` },
      });
    }
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.ok) return { ok: true };
  if (res.status === 401 || res.status === 403) return { ok: false, reason: "invalid" };
  return { ok: false, reason: "http", status: res.status };
}

// 拉网关可用模型列表(OpenAI 兼容 GET /models,解析 data[].id)。用于自定义网关引导:填完
// baseUrl+token 后拉这个列表让用户 ↑↓ 选 model,避免手打拼错(京东网关拼错返回 4010)。
// 任何失败(网络不通 / 非 2xx / 结构不符)都返回 []——调用方据此回退到手动输入 model 名。
export async function fetchModels(
  baseUrl: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  try {
    const res = await fetchImpl(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: { id?: unknown }[] };
    if (!Array.isArray(data?.data)) return [];
    return data.data.map((m) => m?.id).filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}
