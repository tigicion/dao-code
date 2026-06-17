import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadHooks, runHooks } from "./hooks.js";

describe("hook 引擎集成:SessionStart additionalContext 注入", () => {
  it("CC 格式配置 + 脚本输出 hookSpecificOutput.additionalContext → outcome 带注入文本", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hk-int-"));
    const script = path.join(dir, "ss.js");
    writeFileSync(script, `process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:"<EXTREMELY_IMPORTANT>BOOTSTRAP</EXTREMELY_IMPORTANT>"}}))`);
    const cfg = path.join(dir, "hooks.json");
    writeFileSync(cfg, JSON.stringify({ hooks: { SessionStart: [
      { matcher: "startup|clear|compact", hooks: [{ type: "command", command: `${process.execPath} ${script}` }] },
    ] } }));
    const specs = loadHooks([{ path: cfg, pluginRoot: dir }]);
    const out = await runHooks(specs, "SessionStart", { cwd: dir, source: "startup" });
    expect(out.additionalContext).toContain("BOOTSTRAP");
    // 来源不匹配则不触发(source-matcher 闸门)
    const none = await runHooks(specs, "SessionStart", { cwd: dir, source: "resume" });
    expect(none.additionalContext).toBe("");
  });
});
