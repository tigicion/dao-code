import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMemoryAuditSink, summarizeMemoryTrace, formatMemoryReport, summarizeReflectTrace, formatReflectReport, type MemoryTraceEvent } from "./memory_audit.js";

const read = (dir: string) =>
  readFileSync(path.join(dir, "memory-trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as MemoryTraceEvent);

describe("memory_audit sink", () => {
  it("recalled/wrote/distilled 各落一行", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mem-a-"));
    const s = createMemoryAuditSink(dir, {} as NodeJS.ProcessEnv);
    s.recalled(10, 2, 1, { user: 4, semantic: 6 });
    s.wrote("user", false);
    s.wrote("semantic", true);
    s.distilled(5, 3, 2);
    const ev = read(dir);
    expect(ev).toHaveLength(4);
    expect(ev[0]).toMatchObject({ kind: "recalled", injected: 10, stale: 2, changed: 1 });
    expect(ev[3]).toMatchObject({ kind: "distilled", extracted: 5, added: 3, updated: 2 });
  });

  it("DAO_MEMORY_AUDIT=0 → no-op", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mem-a-"));
    const s = createMemoryAuditSink(dir, { DAO_MEMORY_AUDIT: "0" } as unknown as NodeJS.ProcessEnv);
    s.wrote("user", false);
    expect(existsSync(path.join(dir, "memory-trace.jsonl"))).toBe(false);
  });

  it("summarize 算合并率 + 召回 + 蒸馏", () => {
    const ev: MemoryTraceEvent[] = [
      { kind: "recalled", ts: 0, injected: 10, stale: 2, changed: 1, types: { user: 4 } },
      { kind: "wrote", ts: 0, type: "user", merged: false },
      { kind: "wrote", ts: 0, type: "user", merged: true },
      { kind: "distilled", ts: 0, extracted: 5, added: 3, updated: 2 },
    ];
    const sum = summarizeMemoryTrace(ev);
    expect(sum.recall).toMatchObject({ injected: 10, stale: 2 });
    expect(sum.writes).toBe(2);
    expect(sum.writesMerged).toBe(1);
    expect(sum.byType.user).toMatchObject({ total: 2, merged: 1 });
    expect(sum.distill).toMatchObject({ extracted: 5, added: 3, updated: 2 });
    expect(formatMemoryReport(sum)).toContain("合并");
  });

  it("reflected 落行 + summarize 汇总(跑/跳/advisory/记忆/节奏)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mem-a-"));
    const s = createMemoryAuditSink(dir, {} as NodeJS.ProcessEnv);
    s.reflected({ ran: true, onTrack: true, advisoryInjected: false, memAdded: 1, memMerged: 0, interval: 1 });
    s.reflected({ ran: false, onTrack: true, advisoryInjected: false, memAdded: 0, memMerged: 0, interval: 2 });
    s.reflected({ ran: true, onTrack: false, advisoryInjected: true, memAdded: 0, memMerged: 1, interval: 1 });
    const sum = summarizeReflectTrace(read(dir));
    expect(sum).toMatchObject({ rounds: 3, ran: 2, advisories: 1, memAdded: 1, memMerged: 1, lastInterval: 1 });
    expect(formatReflectReport(sum)).toContain("反思器");
    expect(formatReflectReport(sum)).toContain("跳过 1");
  });

  it("reflected note 落行 + 汇总进 notes + 报告展示复述", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mem-note-"));
    const s = createMemoryAuditSink(dir, {} as NodeJS.ProcessEnv);
    s.reflected({ ran: true, onTrack: true, advisoryInjected: false, memAdded: 0, memMerged: 0, interval: 1, note: "在写测试,验收推进,故在轨" });
    s.reflected({ ran: true, onTrack: true, advisoryInjected: false, memAdded: 0, memMerged: 0, interval: 1 }); // 无 note
    const sum = summarizeReflectTrace(read(dir));
    expect(sum.notes).toEqual(["在写测试,验收推进,故在轨"]);
    expect(formatReflectReport(sum)).toContain("复述");
    expect(formatReflectReport(sum)).toContain("在写测试,验收推进,故在轨");
  });
});
