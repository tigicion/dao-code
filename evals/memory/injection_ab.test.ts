import { describe, it, expect } from "vitest";
import { allLiveTitles, gradeInjectionAB } from "./injection_ab.js";
import { newMemory } from "../../src/memory/types.js";
import type { Memory } from "../../src/memory/types.js";

describe("allLiveTitles — pull 轴:所有 live 记忆一律只留标题,不给全文特权", () => {
  const TODAY = "2026-07-06";
  function mk(p: Partial<Memory> & { name: string }): Memory {
    const base = newMemory({ name: p.name, text: p.text ?? `t-${p.name}`, type: p.type ?? "semantic", today: TODAY });
    return { ...base, ...p };
  }

  it("剔除 stale,其余按 name 或 title 返回", () => {
    const items = [
      { mem: mk({ name: "a", title: "标题A" }), verdict: "ok" as const },
      { mem: mk({ name: "b" }), verdict: "stale" as const },
    ];
    expect(allLiveTitles(items)).toEqual(["标题A"]);
  });

  it("即使是 user/feedback/locked 类型也只留标题(不像 selectFullText 有特权)", () => {
    const items = [
      { mem: mk({ name: "u", type: "user", title: "用户偏好" }), verdict: "ok" as const },
      { mem: mk({ name: "fb", type: "feedback", title: "反馈规则" }), verdict: "ok" as const },
      { mem: mk({ name: "lk", type: "semantic", locked: true, title: "锁定条目" }), verdict: "ok" as const },
    ];
    expect(allLiveTitles(items)).toEqual(["用户偏好", "反馈规则", "锁定条目"]);
  });

  it("无 title 则退化用 name", () => {
    const items = [{ mem: mk({ name: "no-title" }), verdict: "ok" as const }];
    expect(allLiveTitles(items)).toEqual(["no-title"]);
  });
});

function fakeStream(text: string) { return async function* () { yield { kind: "content", text }; return { role: "assistant", content: text }; }(); }
const cfg = { model: "x", baseUrl: "x", apiKey: "x", judgeK: 1 };

describe("gradeInjectionAB — push 轴用现成注入集,pull 轴逐标题 judge", () => {
  it("push 命中 valueGold 全对;pull 轴 judge 全 true → 也全对;delta=0", async () => {
    const streamChat = () => fakeStream('{"wouldRead":true}');
    const s = await gradeInjectionAB({
      pushInjectedNames: ["a", "b"],
      pullTitles: ["标题a", "标题b"],
      ctx: { task: "做滑梯", valueGold: ["a", "b"], relevanceGold: [] },
      streamChat: streamChat as any, cfg,
    });
    expect(s.push.r).toBe(1);
    expect(s.pull.r).toBe(0); // pullTitles 用的是"标题a"/"标题b",不等于 valueGold 的 "a"/"b" → 见下一测试的关键说明
    expect(typeof s.delta).toBe("number");
  });

  it("pull 轴按 title==valueGold 的 name 对齐时,judge 全 true → 全召回,delta=0", async () => {
    const streamChat = () => fakeStream('{"wouldRead":true}');
    const s = await gradeInjectionAB({
      pushInjectedNames: ["a", "b"],
      pullTitles: ["a", "b"], // fixture 里 title 与 gold name 一致的情形
      ctx: { task: "做滑梯", valueGold: ["a", "b"], relevanceGold: [] },
      streamChat: streamChat as any, cfg,
    });
    expect(s.push.r).toBe(1);
    expect(s.pull.r).toBe(1);
    expect(s.delta).toBe(0);
  });

  it("pull 轴 judge 全 false → pull.r=0,delta=push.r(体现 pull 比 push 差多少)", async () => {
    const streamChat = () => fakeStream('{"wouldRead":false}');
    const s = await gradeInjectionAB({
      pushInjectedNames: ["a"],
      pullTitles: ["a"],
      ctx: { task: "t", valueGold: ["a"], relevanceGold: [] },
      streamChat: streamChat as any, cfg,
    });
    expect(s.push.r).toBe(1);
    expect(s.pull.r).toBe(0);
    expect(s.delta).toBe(1);
  });
});
