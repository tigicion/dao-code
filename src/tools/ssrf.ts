// S5.3 SSRF 防护:拦截抓取内网/环回/云元数据端点,防被注入诱导去打内部服务或偷云凭据。
// 基于主机名/字面 IP 的保守判定(不做 DNS 解析);命中返回原因,安全返回 null。
export function blockedUrlReason(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return "URL 非法"; }
  if (!/^https?:$/.test(u.protocol)) return `仅允许 http/https(收到 ${u.protocol})`;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, ""); // 去 IPv6 方括号
  if (h === "localhost" || h.endsWith(".localhost")) return "禁止访问 localhost";
  if (h === "metadata.google.internal" || h === "169.254.169.254") return "禁止访问云元数据端点";
  if (h === "0.0.0.0" || h === "::1" || h === "::") return "禁止访问环回/未指定地址";
  // IPv4 环回/内网/链路本地
  if (/^127\./.test(h)) return "禁止访问环回地址(127/8)";
  if (/^10\./.test(h)) return "禁止访问内网地址(10/8)";
  if (/^192\.168\./.test(h)) return "禁止访问内网地址(192.168/16)";
  if (/^169\.254\./.test(h)) return "禁止访问链路本地地址(169.254/16)";
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return "禁止访问内网地址(172.16/12)";
  // IPv6 环回/唯一本地/链路本地
  if (/^(fc|fd)[0-9a-f]{2}:/i.test(h) || /^fe80:/i.test(h)) return "禁止访问内网 IPv6";
  return null;
}
