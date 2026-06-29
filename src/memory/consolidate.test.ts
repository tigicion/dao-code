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

import { consolidate } from "./consolidate.js";

function stubStream(returnText: string) {
  return async function* () { yield { kind: "content", text: returnText }; return { content: returnText }; };
}

describe("consolidate LLM runner", () => {
  it("把 mems 发给模型并解析返回计划", async () => {
    let sentModel = "";
    const plan = await consolidate({
      streamChat: ((opts: any) => { sentModel = opts.model; return stubStream(JSON.stringify({ groups: [{ canonical: { title: "T", text: "X" }, supersede: ["a"], reason: "r" }] }))(); }) as any,
      config: { baseUrl: "u", apiKey: "k" }, model: "m-cheap", scope: "user",
      mems: [{ name: "a", text: "x", type: "user" }],
    });
    expect(sentModel).toBe("m-cheap");
    expect(plan.groups).toHaveLength(1);
  });
  it("模型返回乱码 → 空计划(不抛)", async () => {
    const plan = await consolidate({
      streamChat: (() => stubStream("乱码")()) as any,
      config: { baseUrl: "u", apiKey: "k" }, model: "m", scope: "project",
      mems: [{ name: "a", text: "x", type: "episodic" }],
    });
    expect(plan.groups).toEqual([]);
  });
});

import { applyConsolidationPlan } from "./consolidate.js";
import { writeMemory, loadAllMemories } from "./store.js";
import { newMemory } from "./types.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "consol-"));

describe("applyConsolidationPlan 写回落地", () => {
  it("canonical 写盘 + 被并源 supersede,live 集只剩 canonical", async () => {
    const d = await tmp();
    await writeMemory(d, newMemory({ name: "家长", title: "为2岁孩子做游戏的家长", text: "持续做儿童游戏,懂认知边界", type: "user", today: "2026-06-07", importance: 8 }));
    await writeMemory(d, newMemory({ name: "swiftui-spritekit", title: "偏好 SwiftUI+SpriteKit 做儿童游戏", text: "用 SwiftUI+SpriteKit", type: "user", today: "2026-06-07", importance: 5 }));
    const existing = await loadAllMemories(d, d + "-x");
    const plan = { groups: [{
      canonical: { title: "为2岁孩子做游戏的家长", text: "持续做儿童游戏,懂认知边界;技术上用 SwiftUI+SpriteKit", type: "user", importance: 8, confidence: 0.85, source: "inferred" },
      supersede: ["swiftui-spritekit"],
      reason: "家长画像已涵盖技术偏好",
    }] };
    const r = await applyConsolidationPlan(d, plan, existing, "2026-06-29");
    expect(r).toEqual({ merged: 1, superseded: 1 });
    const live = await loadAllMemories(d, d + "-x");
    expect(live.map((m) => m.name).sort()).toEqual(["家长"]); // 只剩 canonical(slug(title)=家长 命中既有 name)
    expect(live[0]!.text).toContain("SwiftUI");
    const raw = await fs.readFile(path.join(d, "swiftui-spritekit.md"), "utf8");
    expect(raw).toMatch(/status: superseded/);
  });

  it("supersede 指向不存在的 name → 跳过不抛", async () => {
    const d = await tmp();
    const plan = { groups: [{ canonical: { title: "T", text: "X", type: "user" }, supersede: ["不存在"], reason: "r" }] };
    const r = await applyConsolidationPlan(d, plan, [], "2026-06-29");
    expect(r.merged).toBe(1);
    expect(r.superseded).toBe(0);
  });
});

import { maybeConsolidate } from "./consolidate.js";

describe("maybeConsolidate 闸门 + marker", () => {
  it("条数不足 → 不调模型、不写 marker", async () => {
    const d = await tmp();
    await writeMemory(d, newMemory({ name: "a", title: "A", text: "x", type: "user", today: "2026-06-07" }));
    let called = false;
    await maybeConsolidate({
      dir: d, scope: "user", today: "2026-06-29", now: 30 * DAY,
      streamChat: (() => { called = true; return stubStream("{}")(); }) as any,
      config: { baseUrl: "u", apiKey: "k" }, model: "m",
    });
    expect(called).toBe(false);
    await expect(fs.readFile(path.join(d, ".last-consolidation"), "utf8")).rejects.toThrow();
  });

  it("达标 → 跑合并、落地、写 marker、回调 audit", async () => {
    const d = await tmp();
    for (let i = 0; i < 13; i++) await writeMemory(d, newMemory({ name: "m" + i, title: "T" + i, text: "t" + i, type: "user", today: "2026-06-07" }));
    const planJson = JSON.stringify({ groups: [{ canonical: { title: "T0", text: "merged", type: "user" }, supersede: ["m1"], reason: "r" }] });
    let audited: any = null;
    await maybeConsolidate({
      dir: d, scope: "user", today: "2026-06-29", now: 30 * DAY,
      streamChat: (() => stubStream(planJson)()) as any,
      config: { baseUrl: "u", apiKey: "k" }, model: "m",
      onAudit: (e) => { audited = e; },
    });
    expect(audited).toMatchObject({ scope: "user", groups: 1, superseded: 1 });
    const marker = await fs.readFile(path.join(d, ".last-consolidation"), "utf8");
    expect(Number(marker)).toBe(30 * DAY);
    const raw = await fs.readFile(path.join(d, "m1.md"), "utf8");
    expect(raw).toMatch(/status: superseded/);
  });

  it("marker 未过期 → 跳过", async () => {
    const d = await tmp();
    for (let i = 0; i < 13; i++) await writeMemory(d, newMemory({ name: "m" + i, title: "T" + i, text: "t" + i, type: "user", today: "2026-06-07" }));
    await fs.writeFile(path.join(d, ".last-consolidation"), String(30 * DAY - 1 * DAY), "utf8"); // 1 天前
    let called = false;
    await maybeConsolidate({
      dir: d, scope: "user", today: "2026-06-29", now: 30 * DAY,
      streamChat: (() => { called = true; return stubStream("{}")(); }) as any,
      config: { baseUrl: "u", apiKey: "k" }, model: "m",
    });
    expect(called).toBe(false);
  });
});
