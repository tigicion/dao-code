// 把反思器抽出的 ReflectMem 解析成"待 upsert 的 Memory 候选"。
// mergeInto 命中已有记忆(按 title 或 slug 匹配)→ 复用该条 name+type,upsert 走精确键覆盖(即合并增强);
// 否则按自身 title 新建。纯函数、可测;落盘(routeScope+upsert)在 index 接线里。
import type { Memory, MemoryType } from "../memory/types.js";
import { newMemory } from "../memory/types.js";
import { slug, supersedeMemory, upsertMemory, touchMemory } from "../memory/store.js";
import type { ReflectMem, Correction } from "./reflect_result.js";

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

// 按 title 在 existing 里定位一条记忆(title 优先,退化按 name=slug(title))。
function findByTitle(existing: Memory[], target: string): Memory | undefined {
  return existing.find((e) => e.title === target || e.name === slug(target));
}

// 纠错落地:supersede 软删 / revise 改写。上限 cap 防一次误判批量毁库。返回实际处理条数。
export async function applyCorrections(
  corrections: Correction[],
  existing: Memory[],
  dirFor: (t: MemoryType) => string,
  today: string,
  cap = 3,
): Promise<number> {
  let n = 0;
  for (const c of corrections.slice(0, cap)) {
    const target = findByTitle(existing, c.target);
    if (!target || target.locked) continue; // 找不到/锁定 → 跳过,不抛
    const dir = dirFor(target.type);
    if (c.action === "supersede") {
      await supersedeMemory(dir, target.name, target.name, today); // 指向自身=纯失效;软删可追溯
    } else {
      // revise:复用既有 name,upsert 命中既有键覆盖正文
      const revised = newMemory({
        name: target.name,
        title: target.title,
        text: c.newText!,
        type: target.type,
        today,
        importance: target.importance,
        confidence: target.confidence,
        source: target.source,
      });
      await upsertMemory(dir, revised, existing);
    }
    n++;
  }
  return n;
}

// 确认续命:touch 命中的 lastUsed。返回实际 touch 条数。
export async function applyConfirmed(
  confirmed: string[],
  existing: Memory[],
  dirFor: (t: MemoryType) => string,
  today: string,
): Promise<number> {
  let n = 0;
  for (const title of confirmed) {
    const target = findByTitle(existing, title);
    if (!target) continue;
    if (await touchMemory(dirFor(target.type), target.name, today)) n++;
  }
  return n;
}
