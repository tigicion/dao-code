import { describe, it, expect } from "vitest";
import { allLiveTitles } from "./injection_ab.js";
import { newMemory } from "../../src/memory/types.js";
import type { Memory } from "../../src/memory/types.js";

describe("allLiveTitles — pull 轴:所有 live 记忆一律只留标题,不给全文特权", () => {
  const TODAY = "2026-07-06";
  function mk(p: Partial<Memory> & { name: string }): Memory {
    const base = newMemory({ name: p.name, text: p.text ?? `t-${p.name}`, type: p.type ?? "semantic", today: TODAY });
    return { ...base, ...p };
  }

  it("剔除 stale,其余按 name 或 title 返回", () => {
    const items = [
      { mem: mk({ name: "a", title: "标题A" }), verdict: "ok" as const },
      { mem: mk({ name: "b" }), verdict: "stale" as const },
    ];
    expect(allLiveTitles(items)).toEqual(["标题A"]);
  });

  it("即使是 user/feedback/locked 类型也只留标题(不像 selectFullText 有特权)", () => {
    const items = [
      { mem: mk({ name: "u", type: "user", title: "用户偏好" }), verdict: "ok" as const },
      { mem: mk({ name: "fb", type: "feedback", title: "反馈规则" }), verdict: "ok" as const },
      { mem: mk({ name: "lk", type: "semantic", locked: true, title: "锁定条目" }), verdict: "ok" as const },
    ];
    expect(allLiveTitles(items)).toEqual(["用户偏好", "反馈规则", "锁定条目"]);
  });

  it("无 title 则退化用 name", () => {
    const items = [{ mem: mk({ name: "no-title" }), verdict: "ok" as const }];
    expect(allLiveTitles(items)).toEqual(["no-title"]);
  });
});
