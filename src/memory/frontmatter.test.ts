import { describe, it, expect } from "vitest";
import { parseMemoryFile, serializeMemory } from "./frontmatter.js";
import { newMemory } from "./types.js";

describe("frontmatter round-trip", () => {
  it("serializes then parses back equal", () => {
    const m = newMemory({ name: "x", text: "用 pnpm 安装", type: "procedural", today: "2026-06-07", importance: 7, source: "package.json#packageManager", sourceHash: "abc" });
    const text = serializeMemory(m);
    expect(text).toMatch(/^---\n/);
    expect(parseMemoryFile("x", text)).toEqual(m);
  });
  it("tolerates missing optional fields", () => {
    const raw = "---\nname: y\ntype: user\nimportance: 3\ncreated: 2026-06-01\nlastUsed: 2026-06-02\nstatus: active\n---\n用户偏好 TypeScript\n";
    const m = parseMemoryFile("y", raw);
    expect(m?.type).toBe("user");
    expect(m?.text).toBe("用户偏好 TypeScript");
    expect(m?.source).toBeUndefined();
  });
  it("returns null on garbage", () => {
    expect(parseMemoryFile("z", "no frontmatter here")).toBeNull();
  });
});
