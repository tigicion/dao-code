import { describe, it, expect, beforeEach } from "vitest";
import { resolveLang, setLang, getLang, t, tips } from "./i18n.js";
import { zh } from "./messages/zh.js";
import { en } from "./messages/en.js";

// 结构性护栏:zh/en 键集必须完全一致,否则缺失侧 t() 会静默退回 key 字符串。
describe("i18n dict parity", () => {
  it("zh / en 键集对称", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });
});

describe("resolveLang", () => {
  it("DAO_LANG 压过 settings 压过系统 locale", () => {
    expect(resolveLang({ DAO_LANG: "zh", LANG: "en_US" }, "en")).toBe("zh");
  });
  it("settings.lang 压过系统 locale", () => {
    expect(resolveLang({ LANG: "en_US.UTF-8" }, "zh")).toBe("zh");
  });
  it("系统 locale zh* → zh,其余 → en", () => {
    expect(resolveLang({ LANG: "zh_CN.UTF-8" })).toBe("zh");
    expect(resolveLang({ LANG: "fr_FR.UTF-8" })).toBe("en");
  });
  it("LC_ALL 优先于 LANG", () => {
    expect(resolveLang({ LC_ALL: "zh_CN.UTF-8", LANG: "en_US" })).toBe("zh");
  });
  it("全空 → 默认 en", () => {
    expect(resolveLang({})).toBe("en");
  });
  it("非法 DAO_LANG 忽略后向下取系统 locale", () => {
    expect(resolveLang({ DAO_LANG: "xx", LANG: "zh_CN" })).toBe("zh");
  });
  it("DAO_LANG=zh-CN 归一化为 zh", () => {
    expect(resolveLang({ DAO_LANG: "zh-CN" })).toBe("zh");
  });
});

describe("t / setLang", () => {
  beforeEach(() => setLang("en"));
  it("按当前语言取串", () => {
    setLang("zh");
    expect(t("onboard.done")).toBe("✓ 设置完成,开始吧。");
    setLang("en");
    expect(t("onboard.done")).toBe("✓ Setup complete. Let's go.");
  });
  it("位置占位插值", () => {
    setLang("en");
    expect(t("key.envSource", "DEEPSEEK_API_KEY")).toContain("DEEPSEEK_API_KEY");
  });
  it("缺 key 返回 key 本身", () => {
    expect(t("no.such.key")).toBe("no.such.key");
  });
  it("tips 跟随语言且非空", () => {
    setLang("zh"); const zh = tips();
    setLang("en"); const en = tips();
    expect(zh.length).toBeGreaterThan(0);
    expect(en.length).toBe(zh.length);
    expect(zh[0]).not.toBe(en[0]);
  });
  it("has the onboarding step keys in both langs", () => {
    setLang("zh"); expect(t("onboard.provider.volcengine")).toBe("火山引擎(Coding Plan)");
    setLang("en"); expect(t("onboard.provider.volcengine")).toBe("Volcengine (Coding Plan)");
    setLang("en"); expect(t("onboard.progress", 2, 4)).toBe("Step 2 / 4");
  });
});
