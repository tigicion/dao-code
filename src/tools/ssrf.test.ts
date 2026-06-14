import { describe, it, expect } from "vitest";
import { blockedUrlReason } from "./ssrf.js";
import { scrubbedEnv } from "./safe_env.js";

describe("blockedUrlReason (SSRF)", () => {
  it("blocks loopback / private / metadata / non-http", () => {
    expect(blockedUrlReason("http://localhost:8080/x")).toBeTruthy();
    expect(blockedUrlReason("http://127.0.0.1/x")).toBeTruthy();
    expect(blockedUrlReason("http://169.254.169.254/latest/meta-data/")).toBeTruthy();
    expect(blockedUrlReason("http://10.0.0.5/x")).toBeTruthy();
    expect(blockedUrlReason("http://192.168.1.1/x")).toBeTruthy();
    expect(blockedUrlReason("http://172.16.0.1/x")).toBeTruthy();
    expect(blockedUrlReason("http://[::1]/x")).toBeTruthy();
    expect(blockedUrlReason("file:///etc/passwd")).toBeTruthy();
    expect(blockedUrlReason("ftp://example.com")).toBeTruthy();
    expect(blockedUrlReason("not a url")).toBeTruthy();
  });
  it("allows ordinary public URLs", () => {
    expect(blockedUrlReason("https://api.example.com/v1")).toBeNull();
    expect(blockedUrlReason("http://example.org")).toBeNull();
    expect(blockedUrlReason("https://173.16.0.1/x")).toBeNull(); // 173 不是私网
  });
});

describe("scrubbedEnv", () => {
  it("strips sensitive keys but keeps the rest", () => {
    const prev = { ...process.env };
    process.env.DEEPSEEK_API_KEY = "sk-secret";
    process.env.MY_TOKEN = "t";
    process.env.PATH = process.env.PATH || "/usr/bin";
    const e = scrubbedEnv();
    expect(e.DEEPSEEK_API_KEY).toBeUndefined();
    expect(e.MY_TOKEN).toBeUndefined();
    expect(e.PATH).toBeTruthy();
    expect(scrubbedEnv({ FOO: "bar" }).FOO).toBe("bar");
    process.env = prev;
  });
});
