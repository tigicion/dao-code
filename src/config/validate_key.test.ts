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
