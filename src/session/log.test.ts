import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSessionStore, loadState, findResumable } from "./log.js";
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
});
