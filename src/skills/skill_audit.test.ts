import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSkillAuditSink, summarizeSkillTrace, type SkillTraceEvent } from "./skill_audit.js";

describe("createSkillAuditSink", () => {
  it("offered/loaded 各落一行 JSONL", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dao-skillaudit-"));
    const sink = createSkillAuditSink(dir, {} as NodeJS.ProcessEnv);
    sink.offered(1, "改下 tsx 组件", [{ name: "tsx-conv", score: 3 }, { name: "debugging", score: 1 }]);
    sink.loaded(1, "tsx-conv");
    const lines = readFileSync(path.join(dir, "skill-trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as SkillTraceEvent);
    expect(lines).toHaveLength(2); // 1 offered + 1 loaded
    expect(lines[0]).toMatchObject({ kind: "offered", round: 1, candidates: [{ name: "tsx-conv", score: 3 }, { name: "debugging", score: 1 }] });
    expect(lines[1]).toMatchObject({ kind: "loaded", round: 1, name: "tsx-conv" });
  });

  it("DAO_SKILL_AUDIT=0 → no-op,不落盘", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dao-skillaudit-"));
    const sink = createSkillAuditSink(dir, { DAO_SKILL_AUDIT: "0" } as unknown as NodeJS.ProcessEnv);
    sink.offered(1, "x", [{ name: "a", score: 2 }]);
    expect(() => readFileSync(path.join(dir, "skill-trace.jsonl"), "utf8")).toThrow(); // 文件未创建
  });
});

describe("summarizeSkillTrace", () => {
  it("算 采纳率/疑似漏报/漏召回,按 round 去重", () => {
    const ev: SkillTraceEvent[] = [
      { kind: "offered", round: 1, ts: 0, input: "", candidates: [{ name: "A", score: 3 }, { name: "B", score: 1 }] },
      { kind: "loaded", round: 1, ts: 0, name: "A" }, // A:提示且加载
      // B:提示了却没用 → 疑似漏报
      { kind: "offered", round: 2, ts: 0, input: "", candidates: [{ name: "A", score: 5 }] },
      { kind: "loaded", round: 2, ts: 0, name: "A" },
      { kind: "loaded", round: 3, ts: 0, name: "C" }, // C:没提示却被加载 → 漏召回
    ];
    const stats = summarizeSkillTrace(ev);
    const A = stats.find((s) => s.name === "A")!;
    const B = stats.find((s) => s.name === "B")!;
    const C = stats.find((s) => s.name === "C")!;
    expect(A).toMatchObject({ offered: 2, loaded: 2, offeredNotUsed: 0, loadedNoOffer: 0, maxScore: 5, loadRate: 1 });
    expect(B).toMatchObject({ offered: 1, loaded: 0, offeredNotUsed: 1, loadRate: 0 });
    expect(C).toMatchObject({ offered: 0, loaded: 1, loadedNoOffer: 1 });
    // 排序:疑似漏报多的在前 → B 应排在 A 前
    expect(stats.findIndex((s) => s.name === "B")).toBeLessThan(stats.findIndex((s) => s.name === "A"));
  });
});
