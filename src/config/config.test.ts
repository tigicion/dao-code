import { describe, it, expect } from "vitest";
import { readConfig } from "./config.js";

describe("readConfig", () => {
  it("reads api key and applies defaults", () => {
    const cfg = readConfig({ DEEPSEEK_API_KEY: "sk-test" });
    expect(cfg.apiKey).toBe("sk-test");
    expect(cfg.baseUrl).toBe("https://api.deepseek.com");
    expect(cfg.model).toBe("deepseek-v4-pro");
  });

  it("allows overriding base url and model", () => {
    const cfg = readConfig({
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_BASE_URL: "https://proxy.example.com",
      DEEPSEEK_MODEL: "deepseek-v4-flash",
    });
    expect(cfg.baseUrl).toBe("https://proxy.example.com");
    expect(cfg.model).toBe("deepseek-v4-flash");
  });

  it("leaves apiKey undefined (no throw) when missing — onboarding resolves it", () => {
    const cfg = readConfig({});
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.baseUrl).toBe("https://api.deepseek.com");
    expect(cfg.model).toBe("deepseek-v4-pro");
  });

  it("treats an empty-string key as missing", () => {
    expect(readConfig({ DEEPSEEK_API_KEY: "" }).apiKey).toBeUndefined();
  });
});
