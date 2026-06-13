import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPermAuditSink, summarizePermTrace, formatPermReport, type PermTraceEvent } from "./perm_audit.js";

const read = (dir: string) =>
  readFileSync(path.join(dir, "perm-trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as PermTraceEvent);

describe("perm_audit sink", () => {
  it("decided 落一行,mode 由闭包盖戳", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "perm-a-"));
    const s = createPermAuditSink(dir, () => "auto", {} as NodeJS.ProcessEnv);
    s.decided("write_file", "write", "ask-approved", "ask");
    expect(read(dir)[0]).toMatchObject({ tool: "write_file", cap: "write", mode: "auto", decision: "ask-approved", source: "ask" });
  });

  it("DAO_PERM_AUDIT=0 → no-op", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "perm-a-"));
    const s = createPermAuditSink(dir, () => "default", { DAO_PERM_AUDIT: "0" } as unknown as NodeJS.ProcessEnv);
    s.decided("x", "read", "allow", "rule");
    expect(existsSync(path.join(dir, "perm-trace.jsonl"))).toBe(false);
  });

  it("summarize 询问率,询问率高在前", () => {
    const ev: PermTraceEvent[] = [
      { kind: "decided", ts: 0, tool: "write_file", cap: "write", mode: "default", decision: "ask-approved", source: "ask" },
      { kind: "decided", ts: 0, tool: "write_file", cap: "write", mode: "default", decision: "ask-denied", source: "ask" },
      { kind: "decided", ts: 0, tool: "read_file", cap: "read", mode: "default", decision: "allow", source: "rule" },
    ];
    const stats = summarizePermTrace(ev);
    const w = stats.find((s) => s.tool === "write_file")!;
    expect(w).toMatchObject({ askApproved: 1, askDenied: 1 });
    expect(w.askRate).toBeCloseTo(1);
    expect(stats[0]!.tool).toBe("write_file");
    expect(formatPermReport(stats)).toContain("询问率");
  });
});
