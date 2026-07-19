import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSessionStore, loadState, findResumable, listSessions, loadMeta } from "./log.js";
import type { ChatMessage } from "../client/types.js";

let base: string;
beforeEach(() => {
  base = mkdtempSync(path.join(os.tmpdir(), "dao-sess-"));
});

const msgs = (): ChatMessage[] => [
  { role: "system", content: "S" },
  { role: "user", content: "hi" },
  { role: "assistant", content: "yo" },
];
const stateInput = (cwd = "/w") => ({
  cwd,
  model: "deepseek-v4-pro",
  mode: "normal" as const,
  messages: msgs(),
  usage: { promptTokens: 1, completionTokens: 2, cacheHitTokens: 0, cacheMissTokens: 1 },
});

describe("SessionStore", () => {
  it("append 事件写入 events.jsonl(逐行 JSON)", () => {
    const s = createSessionStore(base);
    s.append({ t: "user", text: "你好" });
    s.append({ t: "turn_end" });
    const lines = readFileSync(path.join(s.dir, "events.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).t).toBe("user");
    expect(JSON.parse(lines[0]!).ts).toBeTypeOf("number");
  });

  it("saveState 写 state.json,done 默认 false;markDone 置 true", () => {
    const s = createSessionStore(base);
    s.saveState(stateInput());
    let st = loadState(base, s.id)!;
    expect(st.done).toBe(false);
    expect(st.messages).toHaveLength(3);
    s.markDone();
    st = loadState(base, s.id)!;
    expect(st.done).toBe(true);
  });

  it("findResumable:返回未完成、同 cwd、有用户轮的最近会话;done 的排除", () => {
    const a = createSessionStore(base);
    a.saveState(stateInput("/w"));
    const b = createSessionStore(base);
    b.saveState(stateInput("/w"));
    b.markDone();
    const r = findResumable(base, "/w");
    expect(r?.id).toBe(a.id);
    expect(findResumable(base, "/other")).toBeNull();
  });

  it("空目录 findResumable 返回 null", () => {
    expect(findResumable(path.join(base, "nope"), "/w")).toBeNull();
  });

  it("P3-29 Lite-Log:saveState 写 meta.json,listSessions 只读 meta(不含 messages)", () => {
    const s = createSessionStore(base);
    s.saveState({ ...stateInput("/w"), title: "重构记忆" });
    const meta = loadMeta(base, s.id)!;
    expect(meta.title).toBe("重构记忆");
    expect(meta.userMessageCount).toBe(1);
    expect(meta.messageCount).toBe(3);
    expect((meta as any).messages).toBeUndefined(); // meta 不含正文
    const list = listSessions(base, "/w");
    expect(list.map((m) => m.id)).toContain(s.id);
    expect(listSessions(base, "/other")).toEqual([]); // 按 cwd 过滤
  });

  it("P3-29 listSessions 收齐本工作区会话且按 updatedAt 降序", () => {
    const a = createSessionStore(base); a.saveState(stateInput("/w"));
    const b = createSessionStore(base); b.saveState(stateInput("/w"));
    const list = listSessions(base, "/w");
    expect(list.map((m) => m.id).sort()).toEqual([a.id, b.id].sort()); // 两个都在
    for (let i = 1; i < list.length; i++) expect(list[i - 1]!.updatedAt).toBeGreaterThanOrEqual(list[i]!.updatedAt); // 降序不变式
  });

  it("saveState 派生首条用户消息摘录到 meta.summary,帮 /resume 列表辨认会话内容", () => {
    const s = createSessionStore(base);
    s.saveState(stateInput("/w")); // stateInput 里首条用户消息是 "hi"
    const meta = loadMeta(base, s.id)!;
    expect(meta.summary).toBe("hi");
  });

  it("首条用户消息超长时摘录截断到 60 字符并加省略号,单行(换行/多空格压成单空格)", () => {
    const s = createSessionStore(base);
    const long = "a".repeat(80);
    s.saveState({ ...stateInput("/w"), messages: [{ role: "user", content: `first\nline  two ${long}` }] });
    const meta = loadMeta(base, s.id)!;
    expect(meta.summary!.length).toBe(61); // 60 + "…"
    expect(meta.summary).not.toContain("\n");
    expect(meta.summary!.endsWith("…")).toBe(true);
  });

  it("多模态首条用户消息(content 是 ContentPart[])跳过,summary 为 undefined 而非报错", () => {
    const s = createSessionStore(base);
    s.saveState({ ...stateInput("/w"), messages: [{ role: "user", content: [{ type: "text", text: "图片消息" }] }] });
    const meta = loadMeta(base, s.id)!;
    expect(meta.summary).toBeUndefined();
  });

  it("loadMeta 回退路径(老会话无 meta.json,从 state.json 补算)也派生 summary", () => {
    const s = createSessionStore(base);
    s.saveState(stateInput("/w"));
    unlinkSync(path.join(base, s.id, "meta.json")); // 模拟老会话缺 meta.json
    const meta = loadMeta(base, s.id)!;
    expect(meta.summary).toBe("hi");
  });
});
