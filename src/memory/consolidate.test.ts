import { describe, it, expect } from "vitest";
import { parseConsolidationPlan, shouldConsolidate, consolidationCfg, buildConsolidatePrompt } from "./consolidate.js";

const DAY = 86_400_000;

describe("parseConsolidationPlan", () => {
  it("正常 JSON 解析 groups", () => {
    const raw = JSON.stringify({ groups: [{ canonical: { title: "T", text: "X" }, supersede: ["a", "b"], reason: "r" }] });
    const p = parseConsolidationPlan(raw);
    expect(p.groups).toHaveLength(1);
    expect(p.groups[0]!.supersede).toEqual(["a", "b"]);
  });
  it("带围栏也能抽", () => {
    const raw = "好\n```json\n" + JSON.stringify({ groups: [] }) + "\n```";
    expect(parseConsolidationPlan(raw).groups).toEqual([]);
  });
  it("坏 JSON → 空计划(不抛)", () => {
    expect(parseConsolidationPlan("乱七八糟").groups).toEqual([]);
  });
  it("丢弃缺字段的坏 group(canonical 无 text / supersede 非数组)", () => {
    const raw = JSON.stringify({ groups: [
      { canonical: { title: "T" }, supersede: ["a"], reason: "r" },     // 无 text
      { canonical: { title: "T", text: "X" }, supersede: "a", reason: "r" }, // supersede 非数组
      { canonical: { title: "T", text: "X" }, supersede: ["a"], reason: "r" }, // 好
    ] });
    expect(parseConsolidationPlan(raw).groups).toHaveLength(1);
  });
});

describe("shouldConsolidate", () => {
  const cfg = consolidationCfg("user"); // days 3, min 12
  const now = 10 * DAY;
  it("未到天数 → false", () => {
    expect(shouldConsolidate(now - 1 * DAY, 100, now, cfg)).toBe(false);
  });
  it("到天数但条数不足 → false", () => {
    expect(shouldConsolidate(now - 5 * DAY, 5, now, cfg)).toBe(false);
  });
  it("到天数且条数够 → true", () => {
    expect(shouldConsolidate(now - 5 * DAY, 20, now, cfg)).toBe(true);
  });
  it("从未跑过(lastMs=0)且条数够 → true", () => {
    expect(shouldConsolidate(0, 20, now, cfg)).toBe(true);
  });
});

describe("consolidationCfg / buildConsolidatePrompt", () => {
  it("三作用域力度/阈值不同", () => {
    expect(consolidationCfg("user").force).toBe("aggressive");
    expect(consolidationCfg("knowledge").force).toBe("medium");
    expect(consolidationCfg("project").force).toBe("conservative");
    expect(consolidationCfg("project").min).toBeGreaterThan(consolidationCfg("user").min);
  });
  it("project prompt 强调保守、只并明确冗余", () => {
    const p = buildConsolidatePrompt("project", [{ name: "x", text: "t", type: "episodic" }]);
    expect(p).toContain("保守");
    expect(p).toContain("不跨 source");
  });
});
