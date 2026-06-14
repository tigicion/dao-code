// S5.2 子进程环境脱敏:spawn 出去的命令拿不到 API key 等敏感凭据,
// 防被注入诱导 `echo $DEEPSEEK_API_KEY` / 经网络外传。只剥敏感键,PATH 等照常继承。
const SENSITIVE_ENV = /API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|DEEPSEEK|ANTHROPIC|OPENAI|AWS_(ACCESS|SECRET|SESSION)|GH_TOKEN|GITHUB_TOKEN|NPM_TOKEN|PRIVATE_KEY/i;

export function scrubbedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!SENSITIVE_ENV.test(k)) out[k] = v;
  }
  return { ...out, ...extra };
}
