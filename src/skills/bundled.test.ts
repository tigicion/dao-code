import { describe, it, expect } from "vitest";
import { BUNDLED_SKILLS } from "./bundled.js";

describe("BUNDLED_SKILLS", () => {
  it("内置编程必备技能齐全:simplify/debugging/tdd/planning/code-review", () => {
    const names = BUNDLED_SKILLS.map((b) => b.name).sort();
    expect(names).toEqual(["code-review", "debugging", "planning", "simplify", "tdd"]);
  });

  it("每个内置技能都有非空描述与正文", () => {
    for (const b of BUNDLED_SKILLS) {
      expect(b.description.trim().length, `${b.name} 描述`).toBeGreaterThan(10);
      expect(b.body.trim().length, `${b.name} 正文`).toBeGreaterThan(20);
    }
  });

  it("描述是'何时用'触发式,不内联工作流(对齐 writing-skills SDO:否则模型照描述走、跳过正文)", () => {
    for (const b of BUNDLED_SKILLS) {
      // 不得把工作流步骤塞进描述(箭头流程 / "先…再…最后" 序列)
      expect(b.description, `${b.name} 描述不应内联工作流`).not.toMatch(/→|->|红.*绿|先[^,。]*再[^,。]*(最后|然后)/);
      // 必须含触发语(说明何时该用),而非罗列做法
      expect(b.description, `${b.name} 描述应是触发式`).toMatch(/时用|之前用|前用|时\b|之前/);
    }
  });

  it("描述足够短(常驻前缀,控 token):每条 ≤ 60 字", () => {
    for (const b of BUNDLED_SKILLS) {
      expect(b.description.length, `${b.name} 描述过长(${b.description.length})`).toBeLessThanOrEqual(60);
    }
  });

  it("名字唯一(无重复 bundled)", () => {
    const names = BUNDLED_SKILLS.map((b) => b.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("新增技能引用已有子代理(planning→plan、code-review→verify),做集成而非重复", () => {
    const planning = BUNDLED_SKILLS.find((b) => b.name === "planning")!;
    const review = BUNDLED_SKILLS.find((b) => b.name === "code-review")!;
    expect(planning.body).toContain("plan");
    expect(review.body).toContain("verify");
  });
});
