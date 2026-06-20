import { persistKey, type KeychainPort } from "./credential.js";
import type { Profile, ProfilesConfig, ResolvedCredential } from "./profiles.js";
import type { ValidateResult } from "./validate_key.js";

const REASON_TEXT: Record<string, string> = {
  invalid: "key 无效(鉴权被拒)",
  unreachable: "网络不通,连不上 API",
  http: "API 返回异常",
};

export interface WizardDeps {
  cfg: ProfilesConfig;
  name: string;
  meta: Pick<Profile, "provider" | "baseUrl" | "model">;
  ask: (prompt: string) => Promise<string>;
  write: (s: string) => void;
  validate: (cred: { baseUrl: string; key: string }) => Promise<ValidateResult>;
  kc: KeychainPort;
  preferKeychain: boolean;
}

// 首次运行 / 新增 profile 的引导:粘贴 → 落盘前校验(失败可重试)→ 持久化(钥匙串优先)→ 返回生效凭证。
// 空输入 = 放弃,返回 null。校验对标 opencode wizard,避免存错 key 到首条消息才炸。
export async function runKeyWizard(
  deps: WizardDeps,
): Promise<{ cfg: ProfilesConfig; resolved: ResolvedCredential } | null> {
  const { meta, ask, write, validate, kc, preferKeychain } = deps;
  for (;;) {
    const key = (await ask("请粘贴你的 key: ")).trim();
    if (!key) {
      write("未输入 key,已放弃。\n");
      return null;
    }
    write("正在校验 key…\n");
    const v = await validate({ baseUrl: meta.baseUrl, key });
    if (!v.ok) {
      write(`✗ ${REASON_TEXT[v.reason] ?? "校验失败"},请重试(直接回车放弃)。\n`);
      continue;
    }
    const { cfg, stored } = await persistKey(deps.cfg, deps.name, meta, key, kc, { preferKeychain });
    write(stored === "keychain" ? "✓ 已校验并存入系统钥匙串。\n" : "✓ 已校验并保存(文件,权限 600)。\n");
    return {
      cfg,
      resolved: { key, provider: meta.provider, baseUrl: meta.baseUrl, model: meta.model, source: `profile:${deps.name}` },
    };
  }
}
