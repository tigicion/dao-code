import { describe, it, expect } from "vitest";
import { parseHookOutput } from "./hooks.js";

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
