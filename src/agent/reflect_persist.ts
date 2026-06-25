// 把反思器抽出的 ReflectMem 解析成"待 upsert 的 Memory 候选"。
// mergeInto 命中已有记忆(按 title 或 slug 匹配)→ 复用该条 name+type,upsert 走精确键覆盖(即合并增强);
// 否则按自身 title 新建。纯函数、可测;落盘(routeScope+upsert)在 index 接线里。
import type { Memory } from "../memory/types.js";
import { newMemory } from "../memory/types.js";
import { slug } from "../memory/store.js";
import type { ReflectMem } from "./reflect_result.js";

export function reflectMemToCand(m: ReflectMem, existing: Memory[], today: string): Memory {
  const target = m.mergeInto
    ? existing.find((e) => e.title === m.mergeInto || e.name === slug(m.mergeInto!))
    : undefined;
  return newMemory({
    name: target ? target.name : slug(m.title),
    title: m.title,
    text: m.text,
    type: target ? target.type : m.type, // 合并时保持已有作用域(type),不被新事实改写层级
    today,
    importance: m.importance,
    confidence: m.confidence,
    source: m.source,
  });
}
