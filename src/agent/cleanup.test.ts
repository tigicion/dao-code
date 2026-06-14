import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanup, maybeCleanup } from "./cleanup.js";

let root: string;
const NOW = 1_900_000_000_000; // 固定时间戳(避免依赖 Date.now)
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "dao-clean-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function mk(rel: string, ageDays: number) {
  const p = path.join(root, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, "x");
  const t = (NOW - ageDays * 86_400_000) / 1000;
  await fs.utimes(p, t, t);
}

describe("cleanup", () => {
  it("删过期的 spill/subagents/sessions,保留近期", async () => {
    await mk(".dao/spill/old.txt", 40);
    await mk(".dao/spill/new.txt", 1);
    await mk(".dao/subagents/old.md", 40);
    await mk(".dao/sessions/old-sess/state.json", 40);
    const r = await cleanup(root, 30, NOW);
    expect(r.spill).toBe(1);
    expect(existsSync(path.join(root, ".dao/spill/old.txt"))).toBe(false);
    expect(existsSync(path.join(root, ".dao/spill/new.txt"))).toBe(true); // 近期保留
    expect(existsSync(path.join(root, ".dao/subagents/old.md"))).toBe(false);
    expect(existsSync(path.join(root, ".dao/sessions/old-sess"))).toBe(false);
  });

  it("maybeCleanup 节流:24h 内只清一次", async () => {
    await mk(".dao/spill/old.txt", 40);
    await maybeCleanup(root, NOW); // 第一次:清
    expect(existsSync(path.join(root, ".dao/spill/old.txt"))).toBe(false);
    await mk(".dao/spill/old2.txt", 40);
    await maybeCleanup(root, NOW + 3_600_000); // 1h 后:节流跳过
    expect(existsSync(path.join(root, ".dao/spill/old2.txt"))).toBe(true);
    await maybeCleanup(root, NOW + 2 * 86_400_000); // 2 天后:再清
    expect(existsSync(path.join(root, ".dao/spill/old2.txt"))).toBe(false);
  });

  it("DAO_NO_CLEANUP=1 → 不清", async () => {
    process.env.DAO_NO_CLEANUP = "1";
    await mk(".dao/spill/old.txt", 40);
    await maybeCleanup(root, NOW);
    expect(existsSync(path.join(root, ".dao/spill/old.txt"))).toBe(true);
    delete process.env.DAO_NO_CLEANUP;
  });
});
