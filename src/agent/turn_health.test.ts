import { describe, it, expect } from "vitest";
import { assessTurn, initHealth, errSignature, defaultHealthConfig, type HealthConfig } from "./turn_health.js";

const cfg: HealthConfig = { failureStreakTrip: 3, repeatedErrTrip: 2, refocusEvery: 0 };
const ok = { progressed: true, toolFailures: 0 };
const fail = (errSig?: string) => ({ progressed: false, toolFailures: 1, errSig });

describe("assessTurn — 挑战者(卡住)", () => {
  it("连续失败达阈值 → 触发挑战者,并复位计数", () => {
    let s = initHealth();
    let d = assessTurn(s, fail(), cfg, { longTask: false }); s = d.next; expect(d.challenger).toBe(false);
    d = assessTurn(s, fail(), cfg, { longTask: false }); s = d.next; expect(d.challenger).toBe(false);
    d = assessTurn(s, fail(), cfg, { longTask: false }); s = d.next;
    expect(d.challenger).toBe(true);
    expect(d.reason).toBe("failure-streak");
    expect(s.failureStreak).toBe(0); // 出场后复位
  });

  it("有失败但有推进 → 不算卡住(治'碰文件=进展'误判),连击清零", () => {
    let s = initHealth();
    s = assessTurn(s, fail(), cfg, { longTask: false }).next;
    const d = assessTurn(s, { progressed: true, toolFailures: 1 }, cfg, { longTask: false });
    expect(d.challenger).toBe(false);
    expect(d.next.failureStreak).toBe(0);
  });

  it("同一错误复发达阈值 → 触发挑战者", () => {
    let s = initHealth();
    let d = assessTurn(s, fail("E1"), cfg, { longTask: false }); s = d.next; expect(d.challenger).toBe(false);
    d = assessTurn(s, fail("E1"), cfg, { longTask: false });
    expect(d.challenger).toBe(true);
    expect(d.reason).toBe("repeated-error");
  });

  it("不同错误不累计复发", () => {
    let s = initHealth();
    s = assessTurn(s, fail("E1"), cfg, { longTask: false }).next;
    const d = assessTurn(s, fail("E2"), cfg, { longTask: false });
    expect(d.next.repeatedErr).toBe(1);
  });

  it("成功回合清零失败连击与复发", () => {
    let s = initHealth();
    s = assessTurn(s, fail("E1"), cfg, { longTask: false }).next;
    const d = assessTurn(s, ok, cfg, { longTask: false });
    expect(d.next.failureStreak).toBe(0);
    expect(d.next.repeatedErr).toBe(0);
  });
});

describe("assessTurn — 纠偏者(长任务漂移)", () => {
  const rc: HealthConfig = { ...cfg, refocusEvery: 3 };
  it("非长任务 → 永不触发纠偏", () => {
    let s = initHealth();
    for (let i = 0; i < 10; i++) { const d = assessTurn(s, ok, rc, { longTask: false }); s = d.next; expect(d.refocuser).toBe(false); }
  });
  it("长任务每 N 轮触发并复位", () => {
    let s = initHealth();
    let d = assessTurn(s, ok, rc, { longTask: true }); s = d.next; expect(d.refocuser).toBe(false);
    d = assessTurn(s, ok, rc, { longTask: true }); s = d.next; expect(d.refocuser).toBe(false);
    d = assessTurn(s, ok, rc, { longTask: true }); s = d.next;
    expect(d.refocuser).toBe(true);
    expect(s.turnsSinceRefocus).toBe(0);
  });
  it("refocusEvery=0 → 关闭", () => {
    let s = initHealth();
    for (let i = 0; i < 10; i++) { const d = assessTurn(s, ok, cfg, { longTask: true }); s = d.next; expect(d.refocuser).toBe(false); }
  });
});

describe("defaultHealthConfig — 纠偏默认值", () => {
  it("默认 refocusEvery=3(长任务每 3 轮纠偏)", () => {
    const prev = process.env.DAO_REFOCUS_EVERY;
    delete process.env.DAO_REFOCUS_EVERY;
    expect(defaultHealthConfig().refocusEvery).toBe(3);
    if (prev !== undefined) process.env.DAO_REFOCUS_EVERY = prev;
  });
  it("DAO_REFOCUS_EVERY=0 显式关闭(0 不被默认值吞掉)", () => {
    const prev = process.env.DAO_REFOCUS_EVERY;
    process.env.DAO_REFOCUS_EVERY = "0";
    expect(defaultHealthConfig().refocusEvery).toBe(0);
    if (prev !== undefined) process.env.DAO_REFOCUS_EVERY = prev; else delete process.env.DAO_REFOCUS_EVERY;
  });
});

describe("errSignature", () => {
  it("数字/路径/hex 不同但同类错误 → 同签名", () => {
    const a = errSignature("Error: ENOENT no such file /tmp/abc/x.swift at line 42");
    const b = errSignature("Error: ENOENT no such file /home/y/z.swift at line 99");
    expect(a).toBe(b);
  });
  it("不同错误 → 不同签名", () => {
    expect(errSignature("Error: permission denied")).not.toBe(errSignature("Error: ENOENT no such file"));
  });
});
