import { describe, it, expect } from "vitest";
import { isRepeatComplaint, createReplyChallenge } from "./reply_challenge.js";

// 注:短 CJK 文本的字符二元组 Jaccard 偏低——真实"重提"约 0.2–0.25、全新任务约 0.0。
// 故默认阈值取 ~0.15(偏召回:宁可多放进 pro 挑战者去否,也别漏真申诉)。新任务=0 提供清晰区分。
describe("isRepeatComplaint", () => {
  it("重提同一问题(措辞相近)→ true", () => {
    expect(isRepeatComplaint("画面还是没显示啊", ["画面没有显示"], 0.15)).toBe(true);
  });
  it("全新任务 → false", () => {
    expect(isRepeatComplaint("帮我加一个登录页", ["画面没有显示"], 0.15)).toBe(false);
  });
  it("无历史 → false", () => {
    expect(isRepeatComplaint("画面没有显示", [], 0.15)).toBe(false);
  });
  it("threshold<=0(关闭)→ 永远 false,即便完全相同", () => {
    expect(isRepeatComplaint("一样的话", ["一样的话"], 0)).toBe(false);
  });
  it("取与历史中最相似的一条比阈值", () => {
    expect(isRepeatComplaint("画面依然空白", ["加个按钮", "画面是空白的"], 0.2)).toBe(true);
  });
});

describe("createReplyChallenge", () => {
  it("重提同一问题 → fork 挑战者,结论入队(带前缀),drain 取出后清空", async () => {
    let calls = 0;
    const rc = createReplyChallenge({ reflect: async () => { calls++; return "根因可能是 X"; }, threshold: 0.15 });
    await rc.onUserMessage("画面没有显示");      // 首条:无历史,不触发
    await rc.onUserMessage("画面还是没显示啊");  // 重提:触发
    expect(calls).toBe(1);
    const drained = rc.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toContain("审视者·参考");
    expect(drained[0]).toContain("根因可能是 X");
    expect(rc.drain()).toHaveLength(0);          // 已清空
  });
  it("全新任务 → 不 fork,队列空", async () => {
    let calls = 0;
    const rc = createReplyChallenge({ reflect: async () => { calls++; return "x"; }, threshold: 0.15 });
    await rc.onUserMessage("画面没有显示");
    await rc.onUserMessage("帮我加一个登录页");
    expect(calls).toBe(0);
    expect(rc.drain()).toHaveLength(0);
  });
  it("挑战者返回 null/空 → 不入队", async () => {
    const rc = createReplyChallenge({ reflect: async () => null, threshold: 0.15 });
    await rc.onUserMessage("画面没有显示");
    await rc.onUserMessage("画面还是没显示");
    expect(rc.drain()).toHaveLength(0);
  });
  it("reflect 抛错 → 吞掉、不入队、不抛", async () => {
    const rc = createReplyChallenge({ reflect: async () => { throw new Error("flash down"); }, threshold: 0.15 });
    await rc.onUserMessage("画面没有显示");
    await expect(rc.onUserMessage("画面还是没显示")).resolves.toBeUndefined();
    expect(rc.drain()).toHaveLength(0);
  });
});
