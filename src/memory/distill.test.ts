import { describe, it, expect } from "vitest";
import { distill, isCatalogNoise } from "./distill.js";

describe("isCatalogNoise — 产品目录倾倒的后备过滤", () => {
  it("拦截'用户使用 X 技能/工具'清单式条目", () => {
    expect(isCatalogNoise("用户使用 test-driven-development 技能进行测试")).toBe(true);
    expect(isCatalogNoise("用户使用 grep_files 工具(原 Grep)来搜索代码库")).toBe(true);
    expect(isCatalogNoise("用户维护了一个包含 31 个技能的本地技能库")).toBe(true);
  });
  it("拦截工具改名清单(原 X → Y)", () => {
    expect(isCatalogNoise("用户偏好将工具名从 Task/TodoWrite 改为 agent/todo_write")).toBe(true);
  });
  it("放行真正关于用户的事实", () => {
    expect(isCatalogNoise("用户在学 agent 原理,偏好讲机制")).toBe(false);
    expect(isCatalogNoise("DAO CODE 核心定位:低成本、中国可用,对标 Claude Code")).toBe(false);
    expect(isCatalogNoise("验证必须基于实际证据,不能仅凭测试通过就声称完成")).toBe(false);
  });
});

function fakeStream(text: string) {
  return async function* () { yield { kind: "content", text }; return { role: "assistant", content: text }; }();
}

describe("distill", () => {
  it("parses distilled memories and gates importance", async () => {
    const json = JSON.stringify([
      { text: "用户在学 agent 原理,偏好讲机制", type: "user", importance: 7, confidence: 0.6 },
      { text: "随口一句", type: "episodic", importance: 2 },
    ]);
    const mems = await distill({
      streamChat: () => fakeStream("```json\n" + json + "\n```"),
      config: { baseUrl: "x", apiKey: "x" }, model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "..." }], today: "2026-06-07",
    } as any);
    expect(mems.length).toBe(1); // importance<4 被滤
    expect(mems[0]).toMatchObject({ type: "user", importance: 7, confidence: 0.6 });
    expect(mems[0]?.created).toBe("2026-06-07");
  });

  it("accepts feedback type (用户工作方式指导)", async () => {
    const json = JSON.stringify([
      { text: "先答原理再动手。为什么:用户在学机制。怎么用:问题先给结论与原理。", type: "feedback", importance: 8 },
    ]);
    const mems = await distill({
      streamChat: () => fakeStream(json),
      config: { baseUrl: "x", apiKey: "x" }, model: "x",
      messages: [{ role: "user", content: "..." }], today: "2026-06-07",
    } as any);
    expect(mems.length).toBe(1);
    expect(mems[0]).toMatchObject({ type: "feedback", importance: 8 });
  });

  it("returns [] on non-JSON", async () => {
    const mems = await distill({ streamChat: () => fakeStream("抱歉无法"), config: {}, model: "x", messages: [], today: "2026-06-07" } as any);
    expect(mems).toEqual([]);
  });

  it("excludes system messages from the rendered transcript (so the huge system prompt can't crowd out / derail)", async () => {
    let sent = "";
    const capture = (opts: any) => {
      sent = String(opts.messages[1]?.content ?? ""); // [0]=蒸馏器 system,[1]=渲染的对话
      return fakeStream("[]");
    };
    await distill({
      streamChat: capture,
      config: { baseUrl: "x", apiKey: "x" }, model: "x",
      messages: [
        { role: "system", content: "SYSTEM_PROMPT_SENTINEL_应被排除" },
        { role: "user", content: "我用 pnpm" },
        { role: "assistant", content: "好的" },
      ],
      today: "2026-06-07",
    } as any);
    expect(sent).not.toContain("SYSTEM_PROMPT_SENTINEL");
    expect(sent).toContain("我用 pnpm");
  });
});
