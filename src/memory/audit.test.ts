import { describe, it, expect } from "vitest";
import { assessMemory, formatAudit, type AuditRow } from "./audit.js";
import { newMemory } from "./types.js";

const TODAY = "2026-06-07";
const STALE = "2026-04-12"; // 56 天前 → retention < 0.3
function mem(p: Partial<ReturnType<typeof newMemory>> & { text?: string }) {
  return { ...newMemory({ name: "m", text: p.text ?? "某条记忆", type: "semantic", today: TODAY }), ...p };
}

describe("assessMemory", () => {
  it("status superseded → 已取代", () => {
    expect(assessMemory(mem({ status: "superseded", supersededBy: "x" }), TODAY).flag).toBe("superseded");
  });
  it("目录倾倒文本 → noise", () => {
    expect(assessMemory(mem({ text: "用户使用 test-driven-development 技能进行测试", type: "user" }), TODAY).flag).toBe("noise");
  });
  it("低置信、未命中、低重要度的 user 推断 → lowvalue", () => {
    expect(assessMemory(mem({ text: "也许用户喜欢深色主题", type: "user", confidence: 0.4, uses: 0, importance: 5 }), TODAY).flag).toBe("lowvalue");
  });
  it("陈旧未命中 → stale", () => {
    expect(assessMemory(mem({ type: "semantic", importance: 3, lastUsed: STALE }), TODAY).flag).toBe("stale");
  });
  it("正常事实 → ok", () => {
    expect(assessMemory(mem({ type: "semantic", importance: 7, lastUsed: TODAY }), TODAY).flag).toBe("ok");
  });
});

describe("formatAudit", () => {
  it("空 → 提示为空", () => {
    expect(formatAudit([], TODAY)).toContain("为空");
  });
  it("含噪音 → 汇总 + 删除提示", () => {
    const rows: AuditRow[] = [
      { tier: "用户", mem: mem({ name: "noise1", text: "用户使用 grep_files 工具", type: "user" }), flag: "noise", reason: "x" },
      { tier: "项目", mem: mem({ name: "good1", type: "semantic", importance: 8 }), flag: "ok", reason: "" },
    ];
    const out = formatAudit(rows, TODAY);
    expect(out).toContain("共 2 条");
    expect(out).toContain("noise1");
    expect(out).toContain("/memory delete");
    expect(out).toContain("建议清理 1 条");
  });
});
