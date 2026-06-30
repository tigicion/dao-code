import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { reflectMemToCand, applyCorrections, applyConfirmed } from "./reflect_persist.js";
import { writeMemory, loadAllMemories } from "../memory/store.js";
import { newMemory } from "../memory/types.js";
import type { ReflectMem } from "./reflect_result.js";

const today = "2026-06-25";
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "refpersist-"));

describe("reflectMemToCand — ReflectMem→待 upsert 的 Memory(mergeInto 感知)", () => {
  it("无 mergeInto:name=slug(title),原样建候选", () => {
    const m: ReflectMem = { title: "提交不加署名", text: "提交一律不加 AI 署名", type: "feedback", importance: 9 };
    const c = reflectMemToCand(m, [], today);
    expect(c.name).toBe("提交不加署名");
    expect(c.title).toBe("提交不加署名");
    expect(c.type).toBe("feedback");
    expect(c.importance).toBe(9);
  });

  it("mergeInto 命中已有 title → 复用该条 name+type(upsert 走精确键覆盖)", () => {
    const existing = [newMemory({ name: "中文偏好", title: "中文偏好", text: "用户偏好中文思考", type: "user", today })];
    const m: ReflectMem = { title: "中文偏好(增强)", text: "用户偏好中文思考与回答", type: "feedback", importance: 8, mergeInto: "中文偏好" };
    const c = reflectMemToCand(m, existing, today);
    expect(c.name).toBe("中文偏好");        // 复用已有 name → 覆盖那条
    expect(c.type).toBe("user");             // 复用已有 type(保持作用域一致)
    expect(c.text).toBe("用户偏好中文思考与回答"); // 新的合并正文
  });

  it("mergeInto 指向不存在的 title → 退化为新建(按自身 title/type)", () => {
    const m: ReflectMem = { title: "新事实", text: "x", type: "semantic", mergeInto: "查无此条" };
    const c = reflectMemToCand(m, [], today);
    expect(c.name).toBe("新事实");
    expect(c.type).toBe("semantic");
  });

  it("mergeInto 可按 slug 匹配已有 name", () => {
    const existing = [newMemory({ name: "hello-world", title: "Hello World", text: "x", type: "semantic", today })];
    const m: ReflectMem = { title: "ext", text: "y", type: "semantic", mergeInto: "Hello World" };
    expect(reflectMemToCand(m, existing, today).name).toBe("hello-world");
  });
});

describe("applyCorrections", () => {
  it("supersede 软删、revise 改写、cap 截断", async () => {
    const d = await tmp();
    const dirFor = () => d;
    await writeMemory(d, newMemory({ name: "a", title: "事实A", text: "旧A", type: "semantic", today: "2026-06-01" }));
    await writeMemory(d, newMemory({ name: "b", title: "事实B", text: "旧B", type: "semantic", today: "2026-06-01" }));
    const existing = await loadAllMemories(d, d + "-x");
    const applied = await applyCorrections([
      { target: "事实A", action: "supersede", reason: "已不成立" },
      { target: "事实B", action: "revise", newText: "新B", reason: "更新" },
    ], existing, dirFor, "2026-06-29", 3);
    expect(applied).toHaveLength(2);
    expect(applied.map((c) => c.target)).toEqual(["事实A", "事实B"]); // 顺序保留
    const aRaw = await fs.readFile(path.join(d, "a.md"), "utf8");
    expect(aRaw).toMatch(/status: superseded/);
    const live = await loadAllMemories(d, d + "-x");
    expect(live.find((m) => m.name === "b")!.text).toBe("新B");
  });
  it("找不到 target → 跳过不抛;cap 限制处理条数", async () => {
    const d = await tmp();
    const existing = await loadAllMemories(d, d + "-x");
    expect(await applyCorrections([{ target: "无", action: "supersede", reason: "r" }], existing, () => d, "2026-06-29", 3)).toHaveLength(0);
  });
  it("cap>3 边界:传 4 条只应用前 3 条,第 4 条目标未被改动", async () => {
    const d = await tmp();
    for (const name of ["a", "b", "c", "e"]) {
      await writeMemory(d, newMemory({ name, title: `事实${name}`, text: `旧${name}`, type: "semantic", today: "2026-06-01" }));
    }
    const existing = await loadAllMemories(d, d + "-x");
    const applied = await applyCorrections([
      { target: "事实a", action: "revise", newText: "新a", reason: "1" },
      { target: "事实b", action: "revise", newText: "新b", reason: "2" },
      { target: "事实c", action: "revise", newText: "新c", reason: "3" },
      { target: "事实e", action: "revise", newText: "新e", reason: "4" }, // 超 cap,应被截断
    ], existing, () => d, "2026-06-29", 3);
    expect(applied).toHaveLength(3);
    expect(applied.map((c) => c.target)).toEqual(["事实a", "事实b", "事实c"]);
    const live = await loadAllMemories(d, d + "-x");
    expect(live.find((m) => m.name === "e")!.text).toBe("旧e"); // 第 4 条未动
  });
  it("revise 只改正文:保留 uses/created/importance,且 uses 不 +1", async () => {
    const d = await tmp();
    // 构造一条 uses=2 的既有记忆(newMemory 起始 uses=0,手动抬到 2 落盘)
    const seed = { ...newMemory({ name: "k", title: "事实K", text: "旧K", type: "semantic", today: "2026-06-01", importance: 7, source: "src.ts" }), uses: 2 };
    await writeMemory(d, seed);
    const existing = await loadAllMemories(d, d + "-x");
    const applied = await applyCorrections([{ target: "事实K", action: "revise", newText: "新K", reason: "修订" }], existing, () => d, "2026-06-29", 3);
    expect(applied).toHaveLength(1);
    const live = (await loadAllMemories(d, d + "-x")).find((m) => m.name === "k")!;
    expect(live.text).toBe("新K");      // 正文已改
    expect(live.uses).toBe(2);          // 关键:纠错不刷强化计数,仍 2(未 +1)
    expect(live.created).toBe("2026-06-01"); // created 保留
    expect(live.importance).toBe(7);    // importance 保留
    expect(live.source).toBe("src.ts"); // source 保留
  });
});

describe("applyConfirmed", () => {
  it("touch 命中的 lastUsed", async () => {
    const d = await tmp();
    await writeMemory(d, newMemory({ name: "c", title: "事实C", text: "x", type: "user", today: "2026-06-01" }));
    const existing = await loadAllMemories(d, d + "-x");
    const n = await applyConfirmed(["事实C", "不存在"], existing, () => d, "2026-06-29");
    expect(n).toBe(1);
    expect((await loadAllMemories(d, d + "-x"))[0]!.lastUsed).toBe("2026-06-29");
  });
});
