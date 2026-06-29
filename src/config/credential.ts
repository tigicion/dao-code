import { resolveActive, type Profile, type ProfilesConfig, type ResolvedCredential } from "./profiles.js";
import { addProfile } from "./profiles_store.js";

// 钥匙串端口:注入式抽象,单测用内存假实现,运行时用 macOS/libsecret 适配器(见 keychain.ts)。
export interface KeychainPort {
  get(account: string): Promise<string | undefined>;
  set(account: string, key: string): Promise<boolean>;
  delete(account: string): Promise<void>;
}

const KEYREF_PREFIX = "keychain:";
const accountOf = (name: string) => `dao/${name}`;
const keyRefOf = (name: string) => `${KEYREF_PREFIX}${accountOf(name)}`;

// 解析当前生效凭证:激活 profile(内联 key 直接用,keyRef 则从钥匙串取)。
// 不读环境变量——交互模式只有 profile 一条路径;headless 通过 --api-key CLI 参数传入。
// 缺凭证 → null(需 onboarding 或 headless 传参)。
export async function resolveCredential(
  cfg: ProfilesConfig,
  kc: KeychainPort,
): Promise<ResolvedCredential | null> {
  const name = cfg.activeProfile;
  const p = cfg.profiles[name];
  if (!p) return null;
  let key = p.key;
  if (!key && p.keyRef?.startsWith(KEYREF_PREFIX)) {
    key = await kc.get(p.keyRef.slice(KEYREF_PREFIX.length));
  }
  if (!key) return null;
  return { key, provider: p.provider, baseUrl: p.baseUrl, model: p.model, source: `profile:${name}` };
}

// 持久化某 profile 的 key:优先钥匙串(成功 → 只留 keyRef,不落明文),失败/不优先 → 内联(由 saveProfiles 落 0600 文件)。
export async function persistKey(
  cfg: ProfilesConfig,
  name: string,
  meta: Pick<Profile, "provider" | "baseUrl" | "model">,
  key: string,
  kc: KeychainPort,
  opts: { preferKeychain: boolean },
): Promise<{ cfg: ProfilesConfig; stored: "keychain" | "file" }> {
  if (opts.preferKeychain && (await kc.set(accountOf(name), key))) {
    return { cfg: addProfile(cfg, name, { ...meta, keyRef: keyRefOf(name) }), stored: "keychain" };
  }
  return { cfg: addProfile(cfg, name, { ...meta, key }), stored: "file" };
}
