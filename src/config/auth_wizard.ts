import { persistKey, type KeychainPort } from "./credential.js";
import type { Profile, ProfilesConfig, ResolvedCredential } from "./profiles.js";
import type { ValidateResult } from "./validate_key.js";
import { t } from "../i18n/i18n.js";

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
    const key = (await ask(t("wizard.paste"))).trim();
    if (!key) {
      write(`${t("wizard.abandoned")}\n`);
      return null;
    }
    write(`${t("wizard.validating")}\n`);
    const v = await validate({ baseUrl: meta.baseUrl, key });
    if (!v.ok) {
      const reason = v.reason === "invalid" ? t("validate.reason.invalid")
        : v.reason === "unreachable" ? t("validate.reason.unreachable")
        : v.reason === "http" ? t("validate.reason.http")
        : t("validate.reason.fail");
      write(`${t("wizard.retry", reason)}\n`);
      continue;
    }
    const { cfg, stored } = await persistKey(deps.cfg, deps.name, meta, key, kc, { preferKeychain });
    write(stored === "keychain" ? `${t("wizard.storedKeychain")}\n` : `${t("wizard.storedFile")}\n`);
    return {
      cfg,
      resolved: { key, provider: meta.provider, baseUrl: meta.baseUrl, model: meta.model, source: `profile:${deps.name}` },
    };
  }
}
