import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCacheAuditSink, type CacheAuditEvent } from "../session/cache_audit.js";

// 验证设计核心:主与子 agent 的记录写进【同一个】根 cache.jsonl,且身份/分桶正确。
describe("cache-audit integration: whole tree into one root file", () => {
  it("main and sub records land in the same root cache.jsonl with correct identities", () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ca-int-"));
    const sink = createCacheAuditSink(rootDir, {}); // 同一个 sink 传给主与子
    const u = (p: number, h: number) => ({ prompt_tokens: p, completion_tokens: 5, total_tokens: p + 5, prompt_cache_hit_tokens: h, prompt_cache_miss_tokens: p - h });
    // 模拟主回合
    sink.record({ agent: "main", depth: 0, turn: 0, model: "pro", usage: u(20000, 19000), sys: "SYS", tools: "TLS", tail: "" });
    // 模拟子代理两回合(同一根 sink)
    sink.record({ agent: "sub", subId: "ab", depth: 1, turn: 0, model: "pro", usage: u(20000, 0), sys: "SUBSYS", tools: "TLS", tail: "" });
    sink.record({ agent: "sub", subId: "ab", depth: 1, turn: 1, model: "pro", usage: u(20500, 19500), sys: "SUBSYS", tools: "TLS", tail: "" });
    // 模拟主第二回合,sys 被改写(破缓存)
    sink.record({ agent: "main", depth: 0, turn: 1, model: "pro", usage: u(21000, 1000), sys: "SYS-MUTATED", tools: "TLS", tail: "" });

    const evs = readFileSync(path.join(rootDir, "cache.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as CacheAuditEvent);
    expect(evs).toHaveLength(4);
    // 全部在一个文件里
    expect(evs.filter((e) => e.agent === "main")).toHaveLength(2);
    expect(evs.filter((e) => e.agent === "sub")).toHaveLength(1 + 1);
    // 子代理身份正确
    expect(evs[1]!.subId).toBe("ab");
    expect(evs[1]!.depth).toBe(1);
    // 主第二回合归因到 sys 破缓存,且不被中间子代理的 SUBSYS 干扰
    expect(evs[3]!.changed).toEqual(["sys"]);
    expect(evs[3]!.delta?.sys).toBeTruthy();
  });
});
