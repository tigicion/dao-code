import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCacheAuditSink, divergence, type CacheAuditEvent } from "./cache_audit.js";

const usage = (prompt: number, hit: number) => ({
  prompt_tokens: prompt, completion_tokens: 10, total_tokens: prompt + 10,
  prompt_cache_hit_tokens: hit, prompt_cache_miss_tokens: prompt - hit,
});
const readEvents = (dir: string): (CacheAuditEvent & { ts: number })[] =>
  readFileSync(path.join(dir, "cache.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("cache_audit sink", () => {
  it("appends one event per record with hit ratio and fingerprint", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ca-"));
    const sink = createCacheAuditSink(dir, {});
    sink.record({ agent: "main", depth: 0, turn: 0, model: "pro", usage: usage(1000, 900), sys: "S", tools: "T", tail: "" });
    const ev = readEvents(dir);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.agent).toBe("main");
    expect(ev[0]!.ratio).toBeCloseTo(0.9);
    expect(ev[0]!.hit).toBe(900);
    expect(ev[0]!.changed).toEqual([]); // 首条无可比对象
    expect(typeof ev[0]!.fp.sys).toBe("string");
  });

  it("flags the changed dimension and records a delta when a dim's content changes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ca-"));
    const sink = createCacheAuditSink(dir, {});
    sink.record({ agent: "main", depth: 0, turn: 0, model: "pro", usage: usage(1000, 900), sys: "SYSTEM-A", tools: "T", tail: "" });
    sink.record({ agent: "main", depth: 0, turn: 1, model: "pro", usage: usage(1000, 50), sys: "SYSTEM-B-longer", tools: "T", tail: "" });
    const ev = readEvents(dir);
    expect(ev[1]!.changed).toEqual(["sys"]);
    expect(ev[1]!.delta?.sys?.fromLen).toBe("SYSTEM-A".length);
    expect(ev[1]!.delta?.sys?.toLen).toBe("SYSTEM-B-longer".length);
  });

  it("tracks previous content per agent key (a sub-agent does not pollute main's diff)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ca-"));
    const sink = createCacheAuditSink(dir, {});
    sink.record({ agent: "main", depth: 0, turn: 0, model: "pro", usage: usage(1000, 900), sys: "MAIN", tools: "T", tail: "" });
    sink.record({ agent: "sub", subId: "ab", depth: 1, turn: 0, model: "pro", usage: usage(1000, 0), sys: "SUB", tools: "T", tail: "" });
    sink.record({ agent: "main", depth: 0, turn: 1, model: "pro", usage: usage(1000, 900), sys: "MAIN", tools: "T", tail: "" });
    const ev = readEvents(dir);
    expect(ev[2]!.changed).toEqual([]); // main 的 sys 没变,不受中间 sub 的 SUB 影响
  });

  it("DAO_CACHE_AUDIT=0 produces a no-op sink (no file written)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ca-"));
    const sink = createCacheAuditSink(dir, { DAO_CACHE_AUDIT: "0" });
    sink.record({ agent: "main", depth: 0, turn: 0, model: "pro", usage: usage(1000, 900), sys: "S", tools: "T", tail: "" });
    expect(existsSync(path.join(dir, "cache.jsonl"))).toBe(false);
  });

  it("divergence reports first differing offset and a sample from the new string", () => {
    const d = divergence("hello world", "hello brave world");
    expect(d.firstDiffAt).toBe(6);
    expect(d.sample.startsWith("brave")).toBe(true);
  });
});
