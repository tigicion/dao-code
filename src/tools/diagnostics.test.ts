import { describe, it, expect } from "vitest";
import os from "node:os";
import { runDiagnosticsCmd } from "./diagnostics.js";

describe("runDiagnosticsCmd", () => {
  it("有输出 → 回灌(截断到 4000)", async () => {
    const out = await runDiagnosticsCmd("echo 'TS2304: cannot find name'", os.tmpdir());
    expect(out).toContain("TS2304");
  });
  it("非零退出也把输出当诊断回灌", async () => {
    const out = await runDiagnosticsCmd("echo oops && exit 1", os.tmpdir());
    expect(out).toContain("oops");
  });
  it("干净(无输出)→ undefined,不打扰", async () => {
    const out = await runDiagnosticsCmd("true", os.tmpdir());
    expect(out).toBeUndefined();
  });
});
