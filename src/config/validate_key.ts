import type { Provider } from "./profiles.js";

// 落盘前轻量校验凭证:打 provider 的 /models(最便宜的鉴权请求),确认 key 有效。
// 对标 opencode wizard 的 "runs a model check";避免存了错 key 要到首条消息才炸。
export type ValidateResult =
  | { ok: true }
  | { ok: false; reason: "invalid" } // 401/403:key 无效
  | { ok: false; reason: "unreachable" } // 网络不通
  | { ok: false; reason: "http"; status: number }; // 其它非 2xx

export async function validateCredential(
  cred: { baseUrl: string; key: string; provider?: Provider },
  fetchImpl: typeof fetch = fetch,
): Promise<ValidateResult> {
  let res: Response;
  try {
    if (cred.provider === "volcengine") {
      // coding plan 路径无 /models;用一发最小 chat 探针判鉴权(max_tokens:1)。
      res = await fetchImpl(`${cred.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cred.key}` },
        body: JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "1" }], max_tokens: 1 }),
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
