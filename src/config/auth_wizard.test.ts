import { describe, it, expect } from "vitest";
import { runKeyWizard } from "./auth_wizard.js";
import { DEFAULTS, type ProfilesConfig } from "./profiles.js";

function fakeKeychain() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (a: string) => store.get(a),
    set: async (a: string, k: string) => {
      store.set(a, k);
      return true;
    },
    delete: async (a: string) => void store.delete(a),
  };
}

const base: ProfilesConfig = { version: 2, activeProfile: "default", profiles: {} };
const meta = { provider: "deepseek" as const, ...DEFAULTS.deepseek };

// 收集 write 输出便于断言;ask 按脚本依次返回。
function harness(answers: string[]) {
  const lines: string[] = [];
  let i = 0;
  return {
    out: lines,
    ask: async () => answers[i++] ?? "",
    write: (s: string) => void lines.push(s),
  };
}

describe("runKeyWizard", () => {
  it("validates, persists to keychain, and returns the resolved credential", async () => {
    const h = harness(["sk-good"]);
    const kc = fakeKeychain();
    const r = await runKeyWizard({
      cfg: base,
      name: "default",
      meta,
      ask: h.ask,
      write: h.write,
      validate: async () => ({ ok: true }),
      kc,
      preferKeychain: true,
    });
    expect(r).not.toBeNull();
    expect(r!.resolved.key).toBe("sk-good");
    expect(kc.store.get("dao/default")).toBe("sk-good");
    expect(r!.cfg.profiles.default!.key).toBeUndefined(); // 进了钥匙串,不留明文
  });

  it("re-prompts after an invalid key, then succeeds", async () => {
    const h = harness(["sk-bad", "sk-good"]);
    let calls = 0;
    const r = await runKeyWizard({
      cfg: base,
      name: "default",
      meta,
      ask: h.ask,
      write: h.write,
      validate: async () => (++calls === 1 ? { ok: false, reason: "invalid" } : { ok: true }),
      kc: fakeKeychain(),
      preferKeychain: false,
    });
    expect(r!.resolved.key).toBe("sk-good");
    expect(calls).toBe(2);
    expect(h.out.join("")).toContain("无效");
  });

  it("aborts (returns null) when the user enters an empty key", async () => {
    const h = harness([""]);
    const r = await runKeyWizard({
      cfg: base,
      name: "default",
      meta,
      ask: h.ask,
      write: h.write,
      validate: async () => ({ ok: true }),
      kc: fakeKeychain(),
      preferKeychain: true,
    });
    expect(r).toBeNull();
  });
});
