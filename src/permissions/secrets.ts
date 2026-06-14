// S5.1 秘密扫描:写记忆/写文件前扫常见密钥指纹,防 API key/私钥被持久化或外泄。
// 纯本地;规则与命中内容不出机器。dao 自身 key 前缀运行时拼接,不硬编码进二进制。
const SELF_KEY = ["sk", "-"].join(""); // 运行时拼接,避免源码里出现可被搜出的字面量
const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "私钥块", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: "AWS Access Key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "AWS Secret", re: /aws_secret_access_key\s*[=:]\s*['"]?[A-Za-z0-9/+]{40}/i },
  { name: "GitHub Token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "Slack Token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "Google API Key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "Stripe 密钥", re: /\bsk_live_[0-9A-Za-z]{24,}\b/ },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/ },
  { name: "sk- 风格密钥", re: new RegExp(`\\b${SELF_KEY}[A-Za-z0-9]{20,}\\b`) },
  { name: "密钥赋值", re: /\b(api[_-]?key|secret|token|password|passwd)\b\s*[=:]\s*['"][^'"\s]{12,}['"]/i },
];

// 返回命中的密钥类型名(去重);空数组=未发现。
export function findSecrets(text: string): string[] {
  if (typeof text !== "string" || !text) return [];
  const hits = new Set<string>();
  for (const { name, re } of PATTERNS) if (re.test(text)) hits.add(name);
  return [...hits];
}

// 把命中的密钥替换为 [已隐去:类型];用于日志/记忆兜底脱敏。
export function redactSecrets(text: string): string {
  let out = text;
  for (const { name, re } of PATTERNS) out = out.replace(new RegExp(re, re.flags.includes("g") ? re.flags : re.flags + "g"), `[已隐去:${name}]`);
  return out;
}
