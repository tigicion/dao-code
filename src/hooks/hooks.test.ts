import { describe, it, expect } from "vitest";
import { parseHookOutput, loadHooks, selectHooks } from "./hooks.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("parseHookOutput", () => {
  it("exit 2 -> block, stderr as reason", () => {
    expect(parseHookOutput("", "blocked!", 2)).toMatchObject({ block: true, reason: "blocked!" });
  });
  it("CC JSON hookSpecificOutput.additionalContext", () => {
    const out = parseHookOutput(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "HELLO" } }), "", 0);
    expect(out.additionalContext).toBe("HELLO");
  });
  it("top-level additionalContext / additional_context fallback", () => {
    expect(parseHookOutput(JSON.stringify({ additionalContext: "A" }), "", 0).additionalContext).toBe("A");
    expect(parseHookOutput(JSON.stringify({ additional_context: "B" }), "", 0).additionalContext).toBe("B");
  });
  it("permissionDecision / updatedInput", () => {
    const out = parseHookOutput(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", updatedInput: { command: "ls" } } }), "", 0);
    expect(out.permissionDecision).toBe("deny");
    expect(out.updatedInput).toEqual({ command: "ls" });
  });
  it("non-JSON stdout becomes additionalContext", () => {
    expect(parseHookOutput("plain text", "", 0).additionalContext).toBe("plain text");
  });
});

describe("loadHooks (CC 嵌套格式)", () => {
  it("解外层 {hooks} + 嵌套 hooks[],规范化为 HookSpec[],带 pluginRoot", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hk-"));
    const f = path.join(dir, "hooks.json");
    writeFileSync(f, JSON.stringify({ hooks: { SessionStart: [
      { matcher: "startup|clear", hooks: [{ type: "command", command: "echo hi", timeout: 5000 }] },
    ] } }));
    const specs = loadHooks([{ path: f, pluginRoot: "/PLUGIN" }]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ event: "SessionStart", matcher: "startup|clear", type: "command", command: "echo hi", timeout: 5000, pluginRoot: "/PLUGIN" });
  });
  it("裸 {event:[...]} 也接受(无外层 hooks 包)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hk-"));
    const f = path.join(dir, "h2.json");
    writeFileSync(f, JSON.stringify({ PreToolUse: [{ matcher: "write_file", hooks: [{ type: "command", command: "x", if: "Write(*.ts)" }] }] }));
    const specs = loadHooks([{ path: f }]);
    expect(specs[0]).toMatchObject({ event: "PreToolUse", matcher: "write_file", if: "Write(*.ts)", type: "command", command: "x" });
  });
  it("坏文件跳过", () => {
    expect(loadHooks([{ path: "/no/such/file.json" }])).toEqual([]);
  });
});

const spec = (o: Partial<import("./hooks.js").HookSpec>): import("./hooks.js").HookSpec =>
  ({ event: "X", type: "command", command: "c", ...o } as import("./hooks.js").HookSpec);

describe("selectHooks", () => {
  it("工具事件:matcher 匹配工具名", () => {
    const specs = [spec({ event: "PreToolUse", matcher: "write_file|edit_file" }), spec({ event: "PreToolUse", matcher: "exec_shell" })];
    const sel = selectHooks(specs, "PreToolUse", { toolName: "write_file", argsJson: "{}" });
    expect(sel).toHaveLength(1);
  });
  it("SessionStart:matcher 匹配来源", () => {
    const specs = [spec({ event: "SessionStart", matcher: "startup|clear" }), spec({ event: "SessionStart", matcher: "resume" })];
    expect(selectHooks(specs, "SessionStart", { source: "startup" })).toHaveLength(1);
  });
  it("无 matcher → 全选", () => {
    expect(selectHooks([spec({ event: "SessionStart" })], "SessionStart", { source: "resume" })).toHaveLength(1);
  });
});
