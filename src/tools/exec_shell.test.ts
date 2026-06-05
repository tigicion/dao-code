import { describe, it, expect, afterEach } from "vitest";
import { execShellTool } from "./exec_shell.js";
import { processManager } from "./process_manager.js";

afterEach(() => processManager.reset());
const ctx = { workspaceRoot: process.cwd() };

describe("exec_shell tool", () => {
  it("runs a foreground command and returns stdout + exit code", async () => {
    const out = await execShellTool.handler({ command: "echo fg-hello" }, ctx);
    expect(out).toContain("fg-hello");
    expect(out).toContain("[exit 0]");
  });

  it("reports a non-zero exit code without throwing", async () => {
    const out = await execShellTool.handler({ command: "sh -c 'exit 3'" }, ctx);
    expect(out).toContain("[exit 3]");
  });

  it("starts a background process and returns its id", async () => {
    const out = await execShellTool.handler({ command: "echo bg", background: true }, ctx);
    expect(out).toMatch(/id=proc-\d+/);
  });

  it("declares exec capability and required approval", () => {
    expect(execShellTool.capability).toBe("exec");
    expect(execShellTool.approval).toBe("required");
    expect(execShellTool.name).toBe("exec_shell");
  });
});
