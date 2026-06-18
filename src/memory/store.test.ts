import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAllMemories, upsertMemory, supersedeMemory, migrateLegacy, textSimilarity, GRAY_LOW, DUP_THRESHOLD, routeScope } from "./store.js";
import { newMemory } from "./types.js";

describe("routeScope — 作用域驱动(与 confidence 无关)", () => {
  it("按 type 决定层级", () => {
    expect(routeScope("user")).toBe("user");
    expect(routeScope("feedback")).toBe("user");
    expect(routeScope("procedural")).toBe("knowledge");
    expect(routeScope("semantic")).toBe("project");
    expect(routeScope("episodic")).toBe("project");
  });
  // confidence 不再影响层级(低信心保护改由 GC 的 provisional 耐久门负责)。
});

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "memstore-"));

describe("store md dir", () => {
  it("upsert dedups near-duplicates, updates existing", async () => {
    const d = await tmp();
    await upsertMemory(d, newMemory({ name: "pnpm", text: "项目用 pnpm 安装依赖", type: "procedural", today: "2026-06-07" }), []);
    const all1 = await loadAllMemories(d, d + "-none");
    const r = await upsertMemory(d, newMemory({ name: "pnpm2", text: "项目用 pnpm 安装依赖包", type: "procedural", today: "2026-06-08" }), all1);
    expect(r.action).toBe("updated");
    const all2 = await loadAllMemories(d, d + "-none");
    expect(all2.length).toBe(1); // 没新增第二条
  });
  it("supersede keeps old file but load skips it", async () => {
    const d = await tmp();
    await upsertMemory(d, newMemory({ name: "api", text: "API 用 v1", type: "semantic", today: "2026-06-07" }), []);
    await upsertMemory(d, newMemory({ name: "api-v2", text: "API 用 v2", type: "semantic", today: "2026-06-08" }), []);
    await supersedeMemory(d, "api", "api-v2", "2026-06-08");
    const all = await loadAllMemories(d, d + "-none");
    expect(all.map((m) => m.name)).toEqual(["api-v2"]); // 旧的被跳过
    expect(await fs.readFile(path.join(d, "api.md"), "utf8")).toMatch(/status: superseded/); // 但文件还在
  });
  // 改写式近重复:字符相似度落在灰区,交裁判判合并。
  const A = "用户在 macOS 上使用 pnpm 管理依赖";
  const B = "用户用 pnpm 作为包管理器";
  it("paraphrase pair lands in the gray band (not auto-merged, not auto-new)", () => {
    const s = textSimilarity(A, B);
    expect(s).toBeGreaterThanOrEqual(GRAY_LOW);
    expect(s).toBeLessThan(DUP_THRESHOLD);
  });
  it("gray-band + adjudicate=yes → merges (no new file)", async () => {
    const d = await tmp();
    await upsertMemory(d, newMemory({ name: "a", text: A, type: "user", today: "2026-06-07" }), []);
    let calls = 0;
    const r = await upsertMemory(d, newMemory({ name: "b", text: B, type: "user", today: "2026-06-08" }),
      await loadAllMemories(d, d + "-x"), async () => { calls++; return true; });
    expect(calls).toBe(1);
    expect(r.action).toBe("updated");
    expect((await loadAllMemories(d, d + "-x")).length).toBe(1);
  });
  it("gray-band + adjudicate=no → new file", async () => {
    const d = await tmp();
    await upsertMemory(d, newMemory({ name: "a", text: A, type: "user", today: "2026-06-07" }), []);
    const r = await upsertMemory(d, newMemory({ name: "b", text: B, type: "user", today: "2026-06-08" }),
      await loadAllMemories(d, d + "-x"), async () => false);
    expect(r.action).toBe("added");
    expect((await loadAllMemories(d, d + "-x")).length).toBe(2);
  });
  it("below GRAY_LOW → new without ever calling adjudicate", async () => {
    const d = await tmp();
    await upsertMemory(d, newMemory({ name: "a", text: "用户喜欢养猫", type: "user", today: "2026-06-07" }), []);
    let called = false;
    const r = await upsertMemory(d, newMemory({ name: "b", text: "项目部署在 AWS 东京区", type: "user", today: "2026-06-08" }),
      await loadAllMemories(d, d + "-x"), async () => { called = true; return true; });
    expect(called).toBe(false);
    expect(r.action).toBe("added");
  });
  it("migrates legacy memories.json", async () => {
    const d = await tmp();
    await fs.writeFile(path.join(d, "memories.json"), JSON.stringify([{ text: "偏好 TypeScript" }]));
    await migrateLegacy(d, "2026-06-07");
    const all = await loadAllMemories(d, d + "-none");
    expect(all[0]?.text).toBe("偏好 TypeScript");
    expect(all[0]?.type).toBe("semantic");
  });
});
