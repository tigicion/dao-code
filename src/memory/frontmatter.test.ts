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
  it("title 往返", () => {
    const m = newMemory({ name: "no-ai-sig", title: "提交不加 AI 署名", text: "提交一律不加署名。为什么:用户要求。怎么用:不写 Co-Authored-By。", type: "feedback", today: "2026-06-25", importance: 9 });
    expect(m.title).toBe("提交不加 AI 署名");
    const round = parseMemoryFile("no-ai-sig", serializeMemory(m));
    expect(round?.title).toBe("提交不加 AI 署名");
    expect(round).toEqual(m);
  });
  it("旧文件无 title → title 为 undefined(向后兼容)", () => {
    const raw = "---\nname: y\ntype: user\nimportance: 3\ncreated: 2026-06-01\nlastUsed: 2026-06-02\nstatus: active\n---\n用户偏好 TypeScript\n";
    expect(parseMemoryFile("y", raw)?.title).toBeUndefined();
  });
});
