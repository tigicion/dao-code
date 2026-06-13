import { describe, it, expect } from "vitest";
import { relevantSkills, formatDiscovery } from "./discovery.js";

const sk = (name: string, description: string) => ({ name, description, body: "", dir: "" });
const SKILLS = [
  sk("test-driven-development", "实现任何功能或修 bug 时、写实现代码之前使用——先写测试、看它失败、再写最小代码"),
  sk("debugging", "遇到任何 bug、测试失败或异常行为时用,先定位根因再动手"),
  sk("brainstorming", "做新功能/创造性工作前使用——理清需求、探索方案、输出设计"),
  sk("using-git-worktrees", "需要隔离的功能开发前使用,创建独立 worktree"),
];

describe("relevantSkills", () => {
  it("按关键词重叠选出相关技能", () => {
    const r = relevantSkills("帮我修复一个 bug", SKILLS, 3).map((s) => s.name);
    expect(r).toContain("debugging");
  });
  it("无关输入 → 空", () => {
    expect(relevantSkills("xyz", SKILLS)).toEqual([]);
  });
  // CJK 无词边界:整句中文不能塌缩成一个匹配不上的大块(对照记忆去重的字符二元组方案)。
  it("纯中文输入也能命中(不依赖空格分词)", () => {
    expect(relevantSkills("这个测试一直崩,帮我看看", SKILLS).map((s) => s.name)).toContain("debugging");
    expect(relevantSkills("帮我加一个导出报表的功能", SKILLS).map((s) => s.name)).toContain("brainstorming");
  });
  it("英文/代码标识符仍能命中", () => {
    expect(relevantSkills("debug this failing test", SKILLS).map((s) => s.name)).toContain("debugging");
  });
  it("formatDiscovery 含相关技能名 + 提示;无匹配空串", () => {
    expect(formatDiscovery(relevantSkills("写测试", SKILLS))).toContain("test-driven-development");
    expect(formatDiscovery([])).toBe("");
  });
});
