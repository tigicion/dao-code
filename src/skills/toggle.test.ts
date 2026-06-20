import { describe, it, expect } from "vitest";
import { toggleBundled } from "./bundled.js";

describe("toggleBundled", () => {
  const names = ["simplify", "debugging", "tdd"];

  it("off:把所有内置名加入禁用集,不动磁盘技能的条目", () => {
    const disabled = new Set(["my-disk-skill"]);
    toggleBundled(disabled, names, false);
    expect([...disabled].sort()).toEqual(["debugging", "my-disk-skill", "simplify", "tdd"]);
  });

  it("on:把所有内置名移出禁用集,保留磁盘技能的条目", () => {
    const disabled = new Set(["simplify", "tdd", "my-disk-skill"]);
    toggleBundled(disabled, names, true);
    expect([...disabled]).toEqual(["my-disk-skill"]);
  });

  it("幂等:重复 off 不变,重复 on 不变", () => {
    const a = new Set<string>();
    toggleBundled(a, names, false);
    const snapshot = [...a].sort();
    toggleBundled(a, names, false);
    expect([...a].sort()).toEqual(snapshot);
  });
});
