import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { Onboarding } from "./Onboarding.js";
import { setLang } from "../../i18n/i18n.js";

const DOWN = "\x1B[B", ENTER = "\r";
const delay = (ms = 40) => new Promise((r) => setTimeout(r, ms));
beforeEach(() => setLang("en"));

const welcome = {
  info: { model: "deepseek-v4-pro", thinking: "max", cwd: "/x", version: "0.2.0", branch: "main" },
  caps: { tier: "none" as const, isTTY: true, columns: 80 }, bg: "dark" as const, maxim: { text: "上善若水", chapter: 8 },
};

function deps(over = {}) {
  return {
    welcome, detectedLang: "en" as const,
    validate: vi.fn(async () => ({ ok: true } as const)),
    persist: vi.fn(async (provider, meta, key) => ({ resolved: { key, provider, baseUrl: meta.baseUrl, model: meta.model, source: "profile:default" } })),
    writeLang: vi.fn(async () => {}), trustCurrent: vi.fn(async () => {}), workspaceRoot: "/x",
    ...over,
  };
}

describe("Onboarding state machine", () => {
  it("runs lang→provider→key→trust and finishes with the result", async () => {
    const onFinish = vi.fn(); const d = deps();
    const { stdin, lastFrame } = render(<Onboarding {...d} onFinish={onFinish} />);
    expect(lastFrame()).toContain("DAO CODE");         // banner 在
    expect(lastFrame()).not.toContain("快速开始");      // 页脚不显
    stdin.write(ENTER); await delay();                  // 语言=English(默认)
    stdin.write(ENTER); await delay();                  // provider=deepseek(默认)
    stdin.write("sk-x"); await delay(); stdin.write(ENTER); await delay(60); // key 校验通过
    stdin.write("y"); await delay();                    // 信任
    expect(d.writeLang).toHaveBeenCalledWith("en");
    expect(d.trustCurrent).toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ lang: "en", trusted: true }));
    expect(onFinish.mock.calls[0]?.[0].resolved.key).toBe("sk-x");
  });
  it("aborts (null) on empty key", async () => {
    const onFinish = vi.fn(); const d = deps();
    const { stdin } = render(<Onboarding {...d} onFinish={onFinish} />);
    stdin.write(ENTER); await delay(); stdin.write(ENTER); await delay(); // lang, provider
    stdin.write(ENTER); await delay();                  // 空 key → 放弃
    expect(onFinish).toHaveBeenCalledWith(null);
  });
});
