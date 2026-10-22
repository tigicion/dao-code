import { describe, it, expect, vi, afterEach } from "vitest";
import { dispatchCommand } from "./commands.js";
import { MODELS_BY_PROVIDER } from "../config/profiles.js";
import { Session } from "../session/session.js";
import { setLang, getLang, switchLang } from "../i18n/i18n.js";

// 命令测试只验证切换行为;持久化由 i18n 测试覆盖,禁止写入开发者的真实配置。
vi.mock("../i18n/i18n.js", async (original) => {
  const actual = await original<typeof import("../i18n/i18n.js")>();
  return { ...actual, switchLang: vi.fn(async (lang: Parameters<typeof actual.setLang>[0]) => actual.setLang(lang)) };
});
afterEach(() => {
  setLang("zh");
  vi.clearAllMocks();
});

function sess() {
  return new Session("SYS", "deepseek-v4-pro");
}

describe("dispatchCommand", () => {
  it("treats non-slash input as not a command", () => {
    expect(dispatchCommand("hello", sess()).handled).toBe(false);
  });

  it("/model with no arg toggles pro<->flash", () => {
    const s = sess();
    const r = dispatchCommand("/model", s);
    expect(r.handled).toBe(true);
    expect(s.model).toBe("deepseek-flash");
    dispatchCommand("/model", s);
    expect(s.model).toBe("deepseek-v4-pro");
  });

  it("/model <id> sets the model", () => {
    const s = sess();
    dispatchCommand("/model deepseek-flash", s);
    expect(s.model).toBe("deepseek-flash");
  });

  it("/model 无参在 qianfan 下按当前完整清单循环", () => {
    const s = sess();
    const ids = MODELS_BY_PROVIDER.qianfan.map(m => m.id);
    for (const expected of [...ids.slice(1), ids[0]]) {
      dispatchCommand("/model", s, "qianfan");
      expect(s.model).toBe(expected);
    }
  });

  it("/model glm-5.2 对 qianfan 合法", () => {
    const s = sess();
    const r = dispatchCommand("/model glm-5.2", s, "qianfan");
    expect(r.handled).toBe(true);
    expect(s.model).toBe("glm-5.2");
  });

  it("/model kimi-k2.6 和 ernie-5.1 对 qianfan 合法", () => {
    const s = sess();
    const r1 = dispatchCommand("/model kimi-k2.6", s, "qianfan");
    expect(r1.handled).toBe(true);
    expect(s.model).toBe("kimi-k2.6");
    const r2 = dispatchCommand("/model ernie-5.1", s, "qianfan");
    expect(r2.handled).toBe(true);
    expect(s.model).toBe("ernie-5.1");
  });

  it("/model glm-5.1 对 qianfan 合法", () => {
    const s = sess();
    const r = dispatchCommand("/model glm-5.1", s, "qianfan");
    expect(r.handled).toBe(true);
    expect(s.model).toBe("glm-5.1");
  });

  it("/model 无参在 volcengine 下按完整 13 档循环回到 pro", () => {
    const s = sess(); // 初始 deepseek-v4-pro
    const order = [
      "deepseek-v4-flash",
      "deepseek-v4.1-flash",
      "deepseek-v4.1-flash-economy",
      "doubao-seed-2.1-pro",
      "doubao-seed-2.1-lite",
      "doubao-seed-2.0-mini",
      "doubao-seed-evolving",
      "glm-5.3",
      "glm-5.3-flash",
      "kimi-k2.8-preview",
      "kimi-k3",
      "ark-code-latest",
      "deepseek-v4-pro",
    ];
    for (const expected of order) {
      dispatchCommand("/model", s, "volcengine");
      expect(s.model).toBe(expected);
    }
  });

  it("/model doubao-seed-2.1-pro 和 kimi-k3 对 volcengine 合法", () => {
    const s = sess();
    const r1 = dispatchCommand("/model doubao-seed-2.1-pro", s, "volcengine");
    expect(r1.handled).toBe(true);
    expect(s.model).toBe("doubao-seed-2.1-pro");
    const r2 = dispatchCommand("/model kimi-k3", s, "volcengine");
    expect(r2.handled).toBe(true);
    expect(s.model).toBe("kimi-k3");
  });

  it("/model doubao-seed-2.0-code 对 deepseek 非法,给出可选列表且不改动当前模型", () => {
    const s = sess();
    const r = dispatchCommand("/model doubao-seed-2.0-code", s, "deepseek");
    expect(s.model).toBe("deepseek-v4-pro");
    expect(r.output).toContain("deepseek-v4-pro");
    expect(r.output).toContain("deepseek-flash");
  });

  it("/model glm-5.2 对 deepseek 非法,给出可选列表且不改动当前模型", () => {
    const s = sess();
    const r = dispatchCommand("/model glm-5.2", s, "deepseek");
    expect(s.model).toBe("deepseek-v4-pro");
    expect(r.output).toContain("deepseek-v4-pro");
    expect(r.output).toContain("deepseek-flash");
  });

  it("省略 provider 参数时按 deepseek 处理(向后兼容)", () => {
    const s = sess();
    dispatchCommand("/model", s);
    expect(s.model).toBe("deepseek-flash");
  });

  it("/plan toggles mode", () => {
    const s = sess();
    dispatchCommand("/plan", s);
    expect(s.mode).toBe("plan");
    dispatchCommand("/plan", s);
    expect(s.mode).toBe("normal");
  });

  it("/clear resets the conversation", () => {
    const s = sess();
    s.addUser("a");
    s.lastPromptTokens = 50000;
    s.lastSentLength = 10;
    s.addUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 50 }, "deepseek-v4-pro");
    dispatchCommand("/clear", s);
    expect(s.messages).toHaveLength(1);
    expect(s.lastPromptTokens).toBeUndefined();
    expect(s.lastSentLength).toBe(0);
    // usage 也应归零(Input/Output/Cache hit/Cost 都重置)
    expect(s.usage.promptTokens).toBe(0);
    expect(s.usage.completionTokens).toBe(0);
    expect(s.usage.cacheHitTokens).toBe(0);
    expect(s.cacheHitRatio()).toBe(0);
    expect(s.costCNY()).toBe(0);
  });

  it("/exit signals exit", () => {
    expect(dispatchCommand("/exit", sess()).exit).toBe(true);
  });

  it("/compact signals compaction", () => {
    const r = dispatchCommand("/compact", sess());
    expect(r.handled).toBe(true);
    expect(r.compact).toBe(true);
  });

  it("/lang 带参切换语言并生效", async () => {
    setLang("en");
    const r = dispatchCommand("/lang zh", sess());
    expect(r.handled).toBe(true);
    expect(r.output).toContain("中文");
    expect(switchLang).toHaveBeenCalledWith("zh");
    await vi.waitFor(() => expect(getLang()).toBe("zh")); // switchLang 异步持久化,语言先行生效
    const r2 = dispatchCommand("/lang en", sess());
    expect(r2.output).toContain("English");
    expect(switchLang).toHaveBeenLastCalledWith("en");
    await vi.waitFor(() => expect(getLang()).toBe("en"));
  });

  it("/lang 无参在 zh/en 间切换", async () => {
    setLang("zh");
    dispatchCommand("/lang", sess());
    await vi.waitFor(() => expect(getLang()).toBe("en"));
    dispatchCommand("/lang", sess());
    await vi.waitFor(() => expect(getLang()).toBe("zh"));
  });

  it("/lang 非法参数报错且不改动语言", () => {
    setLang("zh");
    const r = dispatchCommand("/lang fr", sess());
    expect(r.handled).toBe(true);
    expect(r.output).toContain("zh / en");
    expect(getLang()).toBe("zh");
    expect(switchLang).not.toHaveBeenCalled();
  });

  it("unknown command is handled with a hint", () => {
    const r = dispatchCommand("/wat", sess());
    expect(r.handled).toBe(true);
    expect(r.output).toContain("未知命令");
  });

  it("绝对路径（含 /）不当命令处理", () => {
    expect(dispatchCommand("/Users/x/Desktop/a.png", sess()).handled).toBe(false);
    expect(dispatchCommand("/usr/bin/node", sess()).handled).toBe(false);
    expect(dispatchCommand("/var/log/syslog", sess()).handled).toBe(false);
  });

  it("含 . 的路径不当命令处理", () => {
    expect(dispatchCommand("/Desktop/a.jpeg", sess()).handled).toBe(false);
  });

  it("合法命令名（含冒号/下划线/连字符）仍正常分发", () => {
    // 冒号、下划线、连字符是合法命令名字符
    const r = dispatchCommand("/wat", sess());
    expect(r.handled).toBe(true);
  });
});
