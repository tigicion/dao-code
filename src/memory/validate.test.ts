import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateMemory } from "./validate.js";
import { newMemory } from "./types.js";
import { contentHash } from "./hash.js";

describe("validateMemory", () => {
  it("passes user facts with no source", async () => {
    const m = newMemory({ name: "u", text: "偏好 TS", type: "user", today: "2026-06-07" });
    expect((await validateMemory(m, "/nope", "2026-06-07")).verdict).toBe("ok");
  });
  it("stale when source file missing", async () => {
    const m = newMemory({ name: "c", text: "x", type: "semantic", today: "2026-06-07", source: "gone.txt", sourceHash: "abc" });
    expect((await validateMemory(m, os.tmpdir(), "2026-06-07")).verdict).toBe("stale");
  });
  it("changed when hash mismatches", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-"));
    await fs.writeFile(path.join(dir, "f.txt"), "NEW");
    const m = newMemory({ name: "c", text: "x", type: "semantic", today: "2026-06-07", source: "f.txt", sourceHash: contentHash("OLD") });
    const r = await validateMemory(m, dir, "2026-06-07");
    expect(r.verdict).toBe("changed");
  });
  it("ok when hash matches", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-"));
    await fs.writeFile(path.join(dir, "f.txt"), "SAME");
    const m = newMemory({ name: "c", text: "x", type: "semantic", today: "2026-06-07", source: "f.txt", sourceHash: contentHash("SAME") });
    expect((await validateMemory(m, dir, "2026-06-07")).verdict).toBe("ok");
  });
  it("stale when past validUntil", async () => {
    const m = { ...newMemory({ name: "v", text: "x", type: "semantic", today: "2026-06-01" }), validUntil: "2026-06-05" };
    expect((await validateMemory(m, "/nope", "2026-06-07")).verdict).toBe("stale");
  });
});
