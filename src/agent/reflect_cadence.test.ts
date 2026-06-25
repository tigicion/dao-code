import { describe, it, expect } from "vitest";
import { initCadence, tickCadence, applyOutcome, type CadenceState } from "./reflect_cadence.js";

// 默认每回合;连续安静则回退至多 maxInterval;一有产出立刻回 1。
describe("reflect_cadence — 自适应节奏(1..maxInterval)", () => {
  it("起始:每回合都跑", () => {
    expect(tickCadence(initCadence(), 3).run).toBe(true);
  });

  it("安静一次 → interval 升到 2 → 下一回合跳过、再下一回合跑", () => {
    let s: CadenceState = initCadence();
    let d = tickCadence(s, 3); // 回合1:跑
    expect(d.run).toBe(true);
    s = applyOutcome(d.next, true, 3); // 安静 → interval=2
    d = tickCadence(s, 3); // 回合2:counter 1 < 2 → 跳
    expect(d.run).toBe(false);
    d = tickCadence(d.next, 3); // 回合3:counter 2 >= 2 → 跑
    expect(d.run).toBe(true);
  });

  it("有产出立刻回到每回合", () => {
    let s = applyOutcome(initCadence(), true, 3); // interval=2
    s = applyOutcome(s, true, 3); // interval=3
    expect(s.interval).toBe(3);
    s = applyOutcome(s, false, 3); // 有产出 → 1
    expect(s.interval).toBe(1);
  });

  it("interval 封顶 maxInterval", () => {
    let s = initCadence();
    for (let i = 0; i < 10; i++) s = applyOutcome(s, true, 3);
    expect(s.interval).toBe(3);
  });

  it("maxInterval=1 等于固定每回合(关自适应)", () => {
    const s = applyOutcome(initCadence(), true, 1); // 夹回 1
    expect(s.interval).toBe(1);
    expect(tickCadence(s, 1).run).toBe(true);
  });

  it("压缩在即等场景由调用方强制跑,不经 tick(此处只测纯节奏)", () => {
    // 文档化:tickCadence 只管常规节奏;同步必跑由 index 旁路。
    expect(typeof tickCadence).toBe("function");
  });
});
