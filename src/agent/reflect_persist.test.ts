import { describe, it, expect } from "vitest";
import { reflectMemToCand } from "./reflect_persist.js";
import { newMemory } from "../memory/types.js";
import type { ReflectMem } from "./reflect_result.js";

const today = "2026-06-25";

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
