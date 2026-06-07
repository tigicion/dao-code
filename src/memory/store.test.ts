import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAllMemories, upsertMemory, supersedeMemory, migrateLegacy } from "./store.js";
import { newMemory } from "./types.js";

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
  it("migrates legacy memories.json", async () => {
    const d = await tmp();
    await fs.writeFile(path.join(d, "memories.json"), JSON.stringify([{ text: "偏好 TypeScript" }]));
    await migrateLegacy(d, "2026-06-07");
    const all = await loadAllMemories(d, d + "-none");
    expect(all[0]?.text).toBe("偏好 TypeScript");
    expect(all[0]?.type).toBe("semantic");
  });
});
