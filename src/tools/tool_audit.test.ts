import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createToolAuditSink, summarizeToolTrace, formatToolReport, type ToolTraceEvent } from "./tool_audit.js";

const read = (dir: string) =>
  readFileSync(path.join(dir, "tool-trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as ToolTraceEvent);

describe("tool_audit sink", () => {
  it("call 落一行,args 截断 120", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tool-a-"));
    const s = createToolAuditSink(dir, {} as NodeJS.ProcessEnv);
    s.call("read_file", "read", true, 12, "x".repeat(300));
    const ev = read(dir);
    expect(ev[0]).toMatchObject({ kind: "call", name: "read_file", cap: "read", ok: true, durationMs: 12 });
    expect((ev[0] as { args: string }).args.length).toBeLessThanOrEqual(120);
  });

  it("DAO_TOOL_AUDIT=0 → no-op", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tool-a-"));
    const s = createToolAuditSink(dir, { DAO_TOOL_AUDIT: "0" } as unknown as NodeJS.ProcessEnv);
    s.call("x", "read", true, 1, "");
    expect(existsSync(path.join(dir, "tool-trace.jsonl"))).toBe(false);
  });

  it("summarize 错误率/耗时,错误率高在前", () => {
    const ev: ToolTraceEvent[] = [
      { kind: "call", ts: 0, name: "A", cap: "read", ok: true, durationMs: 10, args: "" },
      { kind: "call", ts: 0, name: "A", cap: "read", ok: false, durationMs: 30, args: "" },
      { kind: "call", ts: 0, name: "B", cap: "read", ok: true, durationMs: 5, args: "" },
    ];
    const stats = summarizeToolTrace(ev);
    const A = stats.find((s) => s.name === "A")!;
    expect(A).toMatchObject({ calls: 2, errors: 1, maxMs: 30 });
    expect(A.errorRate).toBeCloseTo(0.5);
    expect(A.avgMs).toBeCloseTo(20);
    expect(stats[0]!.name).toBe("A");
    expect(formatToolReport(stats)).toContain("错误率");
  });
});
