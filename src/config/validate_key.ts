// 落盘前轻量校验凭证:打 provider 的 /models(最便宜的鉴权请求),确认 key 有效。
// 对标 opencode wizard 的 "runs a model check";避免存了错 key 要到首条消息才炸。
export type ValidateResult =
  | { ok: true }
  | { ok: false; reason: "invalid" } // 401/403:key 无效
  | { ok: false; reason: "unreachable" } // 网络不通
  | { ok: false; reason: "http"; status: number }; // 其它非 2xx

export async function validateCredential(
  cred: { baseUrl: string; key: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ValidateResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${cred.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${cred.key}` },
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.ok) return { ok: true };
  if (res.status === 401 || res.status === 403) return { ok: false, reason: "invalid" };
  return { ok: false, reason: "http", status: res.status };
}
