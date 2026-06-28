import { describe, it, expect } from "vitest";
import { validateCredential } from "./validate_key.js";

const cred = { baseUrl: "https://api.deepseek.com", key: "sk-x" };

describe("validateCredential", () => {
  it("calls the provider's /models endpoint with a Bearer header", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const fakeFetch = async (url: string, init?: { headers?: Record<string, string> }) => {
      seenUrl = url;
      seenAuth = init?.headers?.Authorization ?? "";
      return { ok: true, status: 200 } as Response;
    };
    const r = await validateCredential(cred, fakeFetch as unknown as typeof fetch);
    expect(r.ok).toBe(true);
    expect(seenUrl).toBe("https://api.deepseek.com/models");
    expect(seenAuth).toBe("Bearer sk-x");
  });

  it("reports an invalid key on 401", async () => {
    const fakeFetch = async () => ({ ok: false, status: 401 } as Response);
    const r = await validateCredential(cred, fakeFetch as unknown as typeof fetch);
    expect(r).toEqual({ ok: false, reason: "invalid" });
  });

  it("reports unreachable when the request throws", async () => {
    const fakeFetch = async () => {
      throw new Error("ENOTFOUND");
    };
    const r = await validateCredential(cred, fakeFetch as unknown as typeof fetch);
    expect(r).toEqual({ ok: false, reason: "unreachable" });
  });

  it("reports an http error for other non-ok statuses", async () => {
    const fakeFetch = async () => ({ ok: false, status: 500 } as Response);
    const r = await validateCredential(cred, fakeFetch as unknown as typeof fetch);
    expect(r).toEqual({ ok: false, reason: "http", status: 500 });
  });
});

describe("validateCredential · volcengine probe", () => {
  const ark = { baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3", key: "ark-x", provider: "volcengine" as const };

  it("probes chat/completions with a tiny POST for volcengine", async () => {
    let seenUrl = ""; let seenMethod = "";
    const fakeFetch = async (url: string, init?: { method?: string }) => {
      seenUrl = url; seenMethod = init?.method ?? "GET";
      return { ok: true, status: 200 } as Response;
    };
    const r = await validateCredential(ark, fakeFetch as unknown as typeof fetch);
    expect(r.ok).toBe(true);
    expect(seenUrl).toBe("https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions");
    expect(seenMethod).toBe("POST");
  });

  it("reports invalid on 401 for volcengine", async () => {
    const fakeFetch = async () => ({ ok: false, status: 401 } as Response);
    expect(await validateCredential(ark, fakeFetch as unknown as typeof fetch)).toEqual({ ok: false, reason: "invalid" });
  });

  it("reports unreachable when the volcengine probe throws", async () => {
    const fakeFetch = async () => { throw new Error("ENOTFOUND"); };
    expect(await validateCredential(ark, fakeFetch as unknown as typeof fetch)).toEqual({ ok: false, reason: "unreachable" });
  });

  it("still uses /models for deepseek (no provider given)", async () => {
    let seenUrl = "";
    const fakeFetch = async (url: string) => { seenUrl = url; return { ok: true, status: 200 } as Response; };
    await validateCredential({ baseUrl: "https://api.deepseek.com", key: "sk-x" }, fakeFetch as unknown as typeof fetch);
    expect(seenUrl).toBe("https://api.deepseek.com/models");
  });
});
