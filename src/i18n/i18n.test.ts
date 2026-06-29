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
  it("运行时通知/工具标签 ui.* 抽样 zh/en", () => {
    setLang("zh");
    expect(t("ui.account.pastePrompt")).toBe("粘贴新账户的 DeepSeek key(留空取消):");
    expect(t("ui.notice.error", "boom")).toBe("出错:boom");
    expect(t("ui.detail.lines", 3)).toBe("3 行");
    setLang("en");
    expect(t("ui.account.pastePrompt")).toContain("Paste the new account");
    expect(t("ui.notice.error", "boom")).toBe("Error: boom");
    expect(t("ui.detail.lines", 3)).toBe("3 lines");
  });
  it("迁移提示 ui.migrated zh/en", () => {
    setLang("en");
    expect(t("ui.migrated", "/a", "/b")).toBe("✓ Migrated old data: /a → /b");
    setLang("zh");
    expect(t("ui.migrated", "/a", "/b")).toBe("✓ 已迁移旧数据:/a → /b");
  });
  it("斜杠命令描述 cmd.* 抽样 zh/en", () => {
    setLang("zh");
    expect(t("cmd.tasks")).toBe("查看后台任务");
    expect(t("cmd.model")).toBe("切换模型(Pro/Flash)");
    expect(t("cmd.help")).toBe("查看帮助");
    setLang("en");
    expect(t("cmd.tasks")).toBe("Show background tasks");
    expect(t("cmd.model")).toBe("Switch model (Pro/Flash)");
    expect(t("cmd.help")).toBe("Show help");
  });
});

describe("readUserLang / writeUserLang round-trip", () => {
  it("writes lang and reads it back, preserving other fields", async () => {
    const { writeUserLang, readUserLang } = await import("./i18n.js");
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const prevHome = process.env.HOME;
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "dao-i18n-"));
    process.env.HOME = home;
    try {
      // 预置一个含其它字段的 settings.json,确认 writeUserLang 合并而非覆盖。
      await fs.mkdir(path.join(home, ".dao"), { recursive: true });
      await fs.writeFile(path.join(home, ".dao", "settings.json"), JSON.stringify({ permissions: { allow: ["x"] } }));
      await writeUserLang("zh");
      expect(await readUserLang()).toBe("zh");
      const obj = JSON.parse(await fs.readFile(path.join(home, ".dao", "settings.json"), "utf8"));
      expect(obj.lang).toBe("zh");
      expect(obj.permissions).toEqual({ allow: ["x"] }); // 既有字段保留
    } finally {
      if (prevHome !== undefined) process.env.HOME = prevHome; else delete process.env.HOME;
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
