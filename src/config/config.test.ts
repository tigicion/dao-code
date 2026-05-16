import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("reads api key and applies defaults", () => {
    const cfg = loadConfig({ DEEPSEEK_API_KEY: "sk-test" });
    expect(cfg.apiKey).toBe("sk-test");
    expect(cfg.baseUrl).toBe("https://api.deepseek.com");
    expect(cfg.model).toBe("deepseek-v4-pro");
  });

  it("allows overriding base url and model", () => {
    const cfg = loadConfig({
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_BASE_URL: "https://proxy.example.com",
      DEEPSEEK_MODEL: "deepseek-v4-flash",
    });
    expect(cfg.baseUrl).toBe("https://proxy.example.com");
    expect(cfg.model).toBe("deepseek-v4-flash");
  });

  it("throws a clear error when api key is missing", () => {
    expect(() => loadConfig({})).toThrow(/DEEPSEEK_API_KEY/);
  });
});
