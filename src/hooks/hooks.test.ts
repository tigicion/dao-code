import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadHooks, runHooks, type HookConfig } from "./hooks.js";

const cwd = process.cwd();

describe("runHooks", () => {
  it("matcher 匹配的 PreToolUse:命令非0退出 → 阻断且带原因", async () => {
    const cfg: HookConfig = { PreToolUse: [{ matcher: "write_file", command: "echo 禁止写入 >&2; exit 1" }] };
    const r = await runHooks(cfg, "PreToolUse", { cwd, toolName: "write_file" });
    expect(r.block).toBe(true);
    expect(r.reason).toContain("禁止写入");
  });

  it("matcher 不匹配 → 不跑、不阻断", async () => {
    const cfg: HookConfig = { PreToolUse: [{ matcher: "write_file", command: "exit 1" }] };
    const r = await runHooks(cfg, "PreToolUse", { cwd, toolName: "read_file" });
    expect(r.block).toBe(false);
  });

  it("命令成功的 stdout 作为 context", async () => {
    const cfg: HookConfig = { UserPromptSubmit: [{ command: "echo 额外上下文" }] };
    const r = await runHooks(cfg, "UserPromptSubmit", { cwd });
    expect(r.block).toBe(false);
    expect(r.context).toContain("额外上下文");
  });

  it("无匹配事件 → 空结果", async () => {
    const r = await runHooks({}, "SessionStart", { cwd });
    expect(r.block).toBe(false);
    expect(r.context).toBe("");
  });
});

describe("loadHooks", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(path.join(os.tmpdir(), "dao-hooks-"));
  });
  it("合并多个文件;非法 JSON 跳过", async () => {
    const f1 = path.join(base, "a.json");
    const f2 = path.join(base, "b.json");
    writeFileSync(f1, JSON.stringify({ PreToolUse: [{ command: "x" }] }));
    writeFileSync(f2, "{ 坏 json");
    const cfg = await loadHooks([f1, f2, path.join(base, "missing.json")]);
    expect(cfg.PreToolUse).toHaveLength(1);
  });
});
