import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { runDiagnosticsCmd, detectDiagnosticsCmd } from "./diagnostics.js";

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

describe("detectDiagnosticsCmd", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "daodiag-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const mkBin = (name: string) => {
    const bin = path.join(dir, "node_modules", ".bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, name), "#!/bin/sh\n");
  };

  it("空目录 → undefined", () => {
    expect(detectDiagnosticsCmd(dir)).toBeUndefined();
  });

  it("tsconfig.json + 假 .bin/tsc → npx tsc --noEmit", () => {
    fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}");
    mkBin("tsc");
    expect(detectDiagnosticsCmd(dir)).toBe("npx tsc --noEmit");
  });

  it("eslint 配置 + 假 .bin/eslint → npx eslint .", () => {
    fs.writeFileSync(path.join(dir, ".eslintrc.json"), "{}");
    mkBin("eslint");
    expect(detectDiagnosticsCmd(dir)).toBe("npx eslint .");
  });
});
