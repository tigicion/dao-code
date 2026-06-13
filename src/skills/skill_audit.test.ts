import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSkillAuditSink, summarizeSkillTrace, type SkillTraceEvent } from "./skill_audit.js";

describe("createSkillAuditSink", () => {
  it("loaded 落一行 JSONL", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dao-skillaudit-"));
    const sink = createSkillAuditSink(dir, {} as NodeJS.ProcessEnv);
    sink.loaded(1, "tsx-conv");
    sink.loaded(2, "debugging");
    const lines = readFileSync(path.join(dir, "skill-trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as SkillTraceEvent);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ kind: "loaded", round: 1, name: "tsx-conv" });
    expect(lines[1]).toMatchObject({ kind: "loaded", round: 2, name: "debugging" });
  });

  it("DAO_SKILL_AUDIT=0 → no-op,不落盘", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dao-skillaudit-"));
    const sink = createSkillAuditSink(dir, { DAO_SKILL_AUDIT: "0" } as unknown as NodeJS.ProcessEnv);
    sink.loaded(1, "a");
    expect(() => readFileSync(path.join(dir, "skill-trace.jsonl"), "utf8")).toThrow(); // 文件未创建
  });
});

describe("summarizeSkillTrace", () => {
  it("按 round 去重算加载轮数 + 总次数,最常加载在前", () => {
    const ev: SkillTraceEvent[] = [
      { kind: "loaded", round: 1, ts: 0, name: "A" },
      { kind: "loaded", round: 1, ts: 0, name: "A" }, // 同轮重复:total+1,loaded 轮数不变
      { kind: "loaded", round: 2, ts: 0, name: "A" },
      { kind: "loaded", round: 3, ts: 0, name: "B" },
    ];
    const stats = summarizeSkillTrace(ev);
    const A = stats.find((s) => s.name === "A")!;
    const B = stats.find((s) => s.name === "B")!;
    expect(A).toMatchObject({ name: "A", loaded: 2, total: 3 });
    expect(B).toMatchObject({ name: "B", loaded: 1, total: 1 });
    // 排序:加载轮数多的在前 → A 在 B 前
    expect(stats[0]!.name).toBe("A");
  });

  it("旧 offered/activated 事件被忽略(机制已移除)", () => {
    const ev = [
      { kind: "offered", round: 1, ts: 0, input: "x", candidates: [{ name: "Z", score: 3 }] },
      { kind: "loaded", round: 1, ts: 0, name: "A" },
    ] as unknown as SkillTraceEvent[];
    const stats = summarizeSkillTrace(ev);
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ name: "A", loaded: 1, total: 1 });
  });
});
