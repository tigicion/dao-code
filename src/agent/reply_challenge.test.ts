import { describe, it, expect } from "vitest";
import { isRepeatComplaint } from "./reply_challenge.js";

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
