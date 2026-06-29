import { describe, it, expect } from "vitest";
import { resolveCredential, persistKey } from "./credential.js";
import type { ProfilesConfig } from "./profiles.js";

// 假钥匙串:内存 Map,记录调用,替代真 macOS/libsecret(单测不碰系统钥匙串)。
function fakeKeychain(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    get: async (account: string) => store.get(account),
    set: async (account: string, key: string) => {
      store.set(account, key);
      return true;
    },
    delete: async (account: string) => {
      store.delete(account);
    },
  };
}

const dsMeta = { provider: "deepseek" as const, baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro" };

describe("resolveCredential", () => {
  it("returns the inline key of the active profile", async () => {
    const cfg: ProfilesConfig = {
      version: 2,
      activeProfile: "a",
      profiles: { a: { ...dsMeta, key: "sk-inline" } },
    };
    const r = await resolveCredential(cfg, fakeKeychain());
    expect(r).toMatchObject({ key: "sk-inline", source: "profile:a" });
  });

  it("materializes a keychain-backed profile via the keychain port", async () => {
    const cfg: ProfilesConfig = {
      version: 2,
      activeProfile: "work",
      profiles: { work: { ...dsMeta, keyRef: "keychain:dao/work" } },
    };
    const kc = fakeKeychain({ "dao/work": "sk-from-keychain" });
    const r = await resolveCredential(cfg, kc);
    expect(r?.key).toBe("sk-from-keychain");
    expect(r?.source).toBe("profile:work");
  });

  it("returns null when a keychain-backed profile has no stored secret", async () => {
    const cfg: ProfilesConfig = {
      version: 2,
      activeProfile: "work",
      profiles: { work: { ...dsMeta, keyRef: "keychain:dao/work" } },
    };
    expect(await resolveCredential(cfg, fakeKeychain())).toBeNull();
  });
});

describe("persistKey", () => {
  const base: ProfilesConfig = { version: 2, activeProfile: "default", profiles: {} };

  it("stores in the keychain when preferred and available, leaving no inline key", async () => {
    const kc = fakeKeychain();
    const { cfg, stored } = await persistKey(base, "work", dsMeta, "sk-secret", kc, { preferKeychain: true });
    expect(stored).toBe("keychain");
    expect(kc.store.get("dao/work")).toBe("sk-secret");
    expect(cfg.profiles.work!.key).toBeUndefined();
    expect(cfg.profiles.work!.keyRef).toBe("keychain:dao/work");
    expect(cfg.activeProfile).toBe("work");
  });

  it("falls back to an inline file key when the keychain write fails", async () => {
    const kc = { ...fakeKeychain(), set: async () => false };
    const { cfg, stored } = await persistKey(base, "work", dsMeta, "sk-secret", kc, { preferKeychain: true });
    expect(stored).toBe("file");
    expect(cfg.profiles.work!.key).toBe("sk-secret");
    expect(cfg.profiles.work!.keyRef).toBeUndefined();
  });

  it("stores inline when keychain is not preferred", async () => {
    const kc = fakeKeychain();
    const { cfg, stored } = await persistKey(base, "p", dsMeta, "sk", kc, { preferKeychain: false });
    expect(stored).toBe("file");
    expect(cfg.profiles.p!.key).toBe("sk");
    expect(kc.store.size).toBe(0);
  });
});
