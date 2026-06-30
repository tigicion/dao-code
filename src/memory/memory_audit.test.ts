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

  it("summarize + report 汇总 consolidated(合并 pass)", () => {
    const ev: MemoryTraceEvent[] = [
      { kind: "consolidated", ts: 0, scope: "user", groups: 2, superseded: 3, reasons: ["画像维度收敛", "技术偏好并入"] },
      { kind: "consolidated", ts: 0, scope: "project", groups: 1, superseded: 1, reasons: ["两条完成状态去重"] },
    ];
    const sum = summarizeMemoryTrace(ev);
    expect(sum.consolidation).toMatchObject({ runs: 2, groups: 3, superseded: 4 });
    expect(sum.consolidation!.reasons).toHaveLength(3);
    const rep = formatMemoryReport(sum);
    expect(rep).toContain("合并 pass");
    expect(rep).toContain("画像维度收敛");
  });

  it("无 consolidated 事件 → summary.consolidation 为 undefined,报告不含合并 pass 行", () => {
    const sum = summarizeMemoryTrace([{ kind: "wrote", ts: 0, type: "user", merged: false }]);
    expect(sum.consolidation).toBeUndefined();
    expect(formatMemoryReport(sum)).not.toContain("合并 pass");
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

  it("reflected corrected/confirmed 落行 + 汇总 + 报告", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mem-cc-"));
    const s = createMemoryAuditSink(dir, {} as NodeJS.ProcessEnv);
    s.reflected({ ran: true, onTrack: true, advisoryInjected: false, memAdded: 0, memMerged: 0, interval: 1, corrected: 2, confirmed: 3 });
    const sum = summarizeReflectTrace(read(dir));
    expect(sum.corrected).toBe(2);
    expect(sum.confirmed).toBe(3);
    expect(formatReflectReport(sum)).toContain("纠错");
  });

  it("corrected 事件落行 + summarize 收明细 + 报告展示理由", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mem-corr-"));
    const s = createMemoryAuditSink(dir, {} as NodeJS.ProcessEnv);
    s.corrected({ target: "事实A", action: "supersede", reason: "已被实测推翻" });
    s.corrected({ target: "事实B", action: "revise", reason: "数值已更新" });
    s.reflected({ ran: true, onTrack: true, advisoryInjected: false, memAdded: 0, memMerged: 0, interval: 1, corrected: 2, confirmed: 0 });
    const ev = read(dir);
    expect(ev.filter((e: any) => e.kind === "corrected")).toHaveLength(2);
    const sum = summarizeReflectTrace(ev);
    expect(sum.correctedDetails).toHaveLength(2);
    expect(sum.correctedDetails[0]).toMatchObject({ target: "事实A", action: "supersede", reason: "已被实测推翻" });
    expect(sum.corrected).toBe(2); // 计数仍走 reflected 事件聚合,不受明细影响
    const rep = formatReflectReport(sum);
    expect(rep).toContain("纠错明细");
    expect(rep).toContain("数值已更新");
  });

  it("consolidated 事件落行", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mem-c-"));
    const s = createMemoryAuditSink(dir, {} as NodeJS.ProcessEnv);
    s.consolidated({ scope: "user", groups: 2, superseded: 3, reasons: ["a", "b"] });
    const ev = read(dir).find((e: any) => e.kind === "consolidated") as any;
    expect(ev).toMatchObject({ scope: "user", groups: 2, superseded: 3 });
    expect(ev.reasons).toEqual(["a", "b"]);
  });
});
