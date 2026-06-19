import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCacheAuditSink, divergence, formatCacheReport, type CacheAuditEvent } from "./cache_audit.js";

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

  it("distill vs 末轮 main:消息前缀一致 → vsMain 无分歧(firstDiffAt 到末尾)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ca-"));
    const sink = createCacheAuditSink(dir, {});
    const prefix = JSON.stringify([{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }]);
    sink.record({ agent: "main", depth: 0, turn: 5, model: "pro", usage: usage(1000, 900), sys: "S", tools: "T", tail: "", msgs: prefix });
    sink.record({ agent: "distill", depth: 0, turn: 0, model: "pro", usage: usage(1000, 500), sys: "S", tools: "T", tail: "", msgs: prefix });
    const ev = readEvents(dir);
    expect(ev[0]!.fp.msgs).toBe(ev[1]!.fp.msgs); // 前缀逐字节一致 → msgs 指纹相同
    expect(ev[1]!.delta?.vsMain?.firstDiffAt).toBe(prefix.length); // 无分歧
  });

  it("distill vs 末轮 main:消息前缀不一致 → vsMain 标出首处分歧字节", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ca-"));
    const sink = createCacheAuditSink(dir, {});
    const mainMsgs = JSON.stringify([{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }]);
    const distillMsgs = JSON.stringify([{ role: "user", content: "hi" }, { role: "assistant", content: "YO-DIFFERENT" }]);
    sink.record({ agent: "main", depth: 0, turn: 5, model: "pro", usage: usage(1000, 900), sys: "S", tools: "T", tail: "", msgs: mainMsgs });
    sink.record({ agent: "distill", depth: 0, turn: 0, model: "pro", usage: usage(1000, 200), sys: "S", tools: "T", tail: "", msgs: distillMsgs });
    const ev = readEvents(dir);
    expect(ev[0]!.fp.msgs).not.toBe(ev[1]!.fp.msgs);
    expect(ev[1]!.delta?.vsMain?.firstDiffAt).toBeLessThan(distillMsgs.length); // 找到分歧点
    expect(ev[1]!.delta?.vsMain?.sample.length).toBeGreaterThan(0);
  });

  it("divergence reports first differing offset and a sample from the new string", () => {
    const d = divergence("hello world", "hello brave world");
    expect(d.firstDiffAt).toBe(6);
    expect(d.sample.startsWith("brave")).toBe(true);
  });
});

describe("formatCacheReport", () => {
  it("逐轮命中率 + 破缓存维度", () => {
    const evs = [
      { ts: 1000, agent: "main", depth: 0, turn: 0, model: "pro", prompt: 20000, hit: 19000, miss: 1000, completion: 5, ratio: 0.95, fp: {}, changed: [] },
      { ts: 2000, agent: "main", depth: 0, turn: 1, model: "pro", prompt: 21000, hit: 1000, miss: 20000, completion: 5, ratio: 0.05, fp: {}, changed: ["sys"] },
    ] as unknown as import("./cache_audit.js").CacheAuditEvent[];
    const out = formatCacheReport(evs);
    expect(out).toContain("t0");
    expect(out).toContain("破:sys");
  });
});
