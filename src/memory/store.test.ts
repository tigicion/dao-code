import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAllMemories, upsertMemory, writeMemory, deleteMemory, supersedeMemory, migrateLegacy, routeScope, slug, touchMemory } from "./store.js";
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

  it("同 title 不同 name(title 漂移留下的并行残片)→ 收敛为一条并删残片", async () => {
    const d = await tmp();
    // 模拟 mergeInto 改 title 不改 name 后的脏状态:两文件同 title、不同 name。
    await writeMemory(d, newMemory({ name: "impl-status", title: "完成状态", text: "v1", type: "episodic", today: "2026-06-07" }));
    await writeMemory(d, newMemory({ name: "proj-status-14-commit", title: "完成状态", text: "v2", type: "episodic", today: "2026-06-07" }));
    expect((await fs.readdir(d)).filter((f) => f.endsWith(".md")).length).toBe(2);

    const existing = await loadAllMemories(d, d + "-x");
    const r = await upsertMemory(d, newMemory({ name: slug("完成状态"), title: "完成状态", text: "v3", type: "episodic", today: "2026-06-08" }), existing);
    expect(r.action).toBe("updated");

    const files = (await fs.readdir(d)).filter((f) => f.endsWith(".md"));
    expect(files.length).toBe(1); // 残片已删
    const all = await loadAllMemories(d, d + "-x");
    expect(all.length).toBe(1);
    expect(all[0]!.text).toBe("v3");
  });

  it("locked 残片不被收敛删除", async () => {
    const d = await tmp();
    await writeMemory(d, { ...newMemory({ name: "keep", title: "完成状态", text: "锁定", type: "episodic", today: "2026-06-07" }), locked: true });
    await writeMemory(d, newMemory({ name: "dup", title: "完成状态", text: "未锁", type: "episodic", today: "2026-06-07" }));
    // cand 同 title,匹配到未锁的 dup(locked 被 find 跳过)→ 更新 dup;keep 是 locked,不删。
    const r = await upsertMemory(d, newMemory({ name: slug("完成状态"), title: "完成状态", text: "v2", type: "episodic", today: "2026-06-08" }), await loadAllMemories(d, d + "-x"));
    expect(r.action).toBe("updated");
    const files = (await fs.readdir(d)).filter((f) => f.endsWith(".md"));
    expect(files).toContain("keep.md");
  });
});

describe("deleteMemory — 真删除文件", () => {
  it("按 title 命中跨 dir 删除", async () => {
    const d = await tmp();
    await writeMemory(d, newMemory({ name: "x", title: "要删的", text: "t", type: "semantic", today: "2026-06-07" }));
    const removed = await deleteMemory([d, d + "-none"], "要删的");
    expect(removed).toEqual(["x"]);
    expect((await loadAllMemories(d, d + "-x")).length).toBe(0);
  });

  it("按 name 命中删除", async () => {
    const d = await tmp();
    await writeMemory(d, newMemory({ name: "my-mem", text: "t", type: "semantic", today: "2026-06-07" }));
    const removed = await deleteMemory([d], "my-mem");
    expect(removed).toEqual(["my-mem"]);
  });

  it("locked 不被删", async () => {
    const d = await tmp();
    await writeMemory(d, { ...newMemory({ name: "p", title: "受保护", text: "t", type: "user", today: "2026-06-07" }), locked: true });
    expect(await deleteMemory([d], "受保护")).toEqual([]);
  });

  it("无命中返回空", async () => {
    const d = await tmp();
    expect(await deleteMemory([d], "不存在")).toEqual([]);
  });
});

describe("touchMemory — 被验证使用续命", () => {
  it("只刷新 lastUsed,不改 text/uses/importance", async () => {
    const d = await tmp();
    await writeMemory(d, { ...newMemory({ name: "m", title: "T", text: "原文", type: "user", today: "2026-06-01", importance: 7 }), uses: 3 });
    const ok = await touchMemory(d, "m", "2026-06-29");
    expect(ok).toBe(true);
    const all = await loadAllMemories(d, d + "-x");
    expect(all[0]!.lastUsed).toBe("2026-06-29");
    expect(all[0]!.text).toBe("原文");
    expect(all[0]!.uses).toBe(3);
    expect(all[0]!.importance).toBe(7);
  });
  it("不存在的 name → false,不抛", async () => {
    const d = await tmp();
    expect(await touchMemory(d, "没有", "2026-06-29")).toBe(false);
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
