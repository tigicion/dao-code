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

  it("kills the foreground child on abort and returns promptly with [已中断]", async () => {
    const controller = new AbortController();
    const start = Date.now();
    const p = execShellTool.handler(
      { command: "sleep 5" },
      { workspaceRoot: process.cwd(), signal: controller.signal },
    );
    // 给子进程一点启动时间再 abort,确认它被 SIGTERM 提前结束而非跑满 5s。
    setTimeout(() => controller.abort(), 100);
    const out = await p;
    const elapsed = Date.now() - start;
    expect(out).toContain("[已中断]");
    expect(elapsed).toBeLessThan(3000);
  });

  it("declares exec capability and required approval", () => {
    expect(execShellTool.capability).toBe("exec");
    expect(execShellTool.approval).toBe("required");
    expect(execShellTool.name).toBe("exec_shell");
  });
});
