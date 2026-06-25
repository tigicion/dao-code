import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAllMemories, upsertMemory, supersedeMemory, migrateLegacy, routeScope, slug } from "./store.js";
import { newMemory } from "./types.js";

describe("routeScope — 作用域驱动(与 confidence 无关)", () => {
  it("按 type 决定层级", () => {
    expect(routeScope("user")).toBe("user");
    expect(routeScope("feedback")).toBe("user");
    expect(routeScope("procedural")).toBe("knowledge");
    expect(routeScope("semantic")).toBe("project");
    expect(routeScope("episodic")).toBe("project");
  });
});

describe("slug", () => {
  it("小写、非字母数字转连字符、截断 40", () => {
    expect(slug("Hello World!")).toBe("hello-world");
    expect(slug("提交不加 AI 署名")).toBe("提交不加-ai-署名");
    expect(slug("")).toBe("mem");
  });
});

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "memstore-"));

describe("upsertMemory — 精确键(name)去重", () => {
  it("同 name → 覆盖更新(不新增、uses+1、importance 取大)", async () => {
    const d = await tmp();
    await upsertMemory(d, newMemory({ name: "pnpm", text: "项目用 pnpm", type: "procedural", today: "2026-06-07", importance: 5 }), []);
    const all1 = await loadAllMemories(d, d + "-none");
    const r = await upsertMemory(d, newMemory({ name: "pnpm", text: "项目用 pnpm 安装依赖", type: "procedural", today: "2026-06-08", importance: 8 }), all1);
    expect(r.action).toBe("updated");
    const all2 = await loadAllMemories(d, d + "-none");
    expect(all2.length).toBe(1);
    expect(all2[0]!.text).toBe("项目用 pnpm 安装依赖");
    expect(all2[0]!.importance).toBe(8);
    expect(all2[0]!.uses).toBe(1);
  });

  it("不同 name(哪怕正文相近)→ 新增(语义合并交反思器,store 不模糊)", async () => {
    const d = await tmp();
    await upsertMemory(d, newMemory({ name: "a", text: "用户用 pnpm 管理依赖", type: "user", today: "2026-06-07" }), []);
    const r = await upsertMemory(d, newMemory({ name: "b", text: "用户用 pnpm 作为包管理器", type: "user", today: "2026-06-08" }), await loadAllMemories(d, d + "-x"));
    expect(r.action).toBe("added");
    expect((await loadAllMemories(d, d + "-x")).length).toBe(2);
  });

  it("locked 的同名不被覆盖 → 新增", async () => {
    const d = await tmp();
    const locked = { ...newMemory({ name: "x", text: "旧", type: "user", today: "2026-06-07" }), locked: true };
    await upsertMemory(d, locked, []);
    const r = await upsertMemory(d, newMemory({ name: "x", text: "新", type: "user", today: "2026-06-08" }), await loadAllMemories(d, d + "-x"));
    expect(r.action).toBe("added");
  });

  it("title 随更新带过去", async () => {
    const d = await tmp();
    await upsertMemory(d, newMemory({ name: "t", title: "旧标题", text: "x", type: "semantic", today: "2026-06-07" }), []);
    await upsertMemory(d, newMemory({ name: "t", title: "新标题", text: "y", type: "semantic", today: "2026-06-08" }), await loadAllMemories(d, d + "-x"));
    expect((await loadAllMemories(d, d + "-x"))[0]!.title).toBe("新标题");
  });
});

describe("store md dir 其它", () => {
  it("supersede keeps old file but load skips it", async () => {
    const d = await tmp();
    await upsertMemory(d, newMemory({ name: "api", text: "API 用 v1", type: "semantic", today: "2026-06-07" }), []);
    await upsertMemory(d, newMemory({ name: "api-v2", text: "API 用 v2", type: "semantic", today: "2026-06-08" }), []);
    await supersedeMemory(d, "api", "api-v2", "2026-06-08");
    const all = await loadAllMemories(d, d + "-none");
    expect(all.map((m) => m.name)).toEqual(["api-v2"]);
    expect(await fs.readFile(path.join(d, "api.md"), "utf8")).toMatch(/status: superseded/);
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
