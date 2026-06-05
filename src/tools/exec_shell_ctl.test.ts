import { describe, it, expect, afterEach } from "vitest";
import { execShellPollTool } from "./exec_shell_poll.js";
import { execShellKillTool } from "./exec_shell_kill.js";
import { processManager } from "./process_manager.js";

afterEach(() => processManager.reset());
const ctx = { workspaceRoot: process.cwd() };

async function waitFor(pred: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("exec_shell_poll / exec_shell_kill", () => {
  it("polls a background process's output and status", async () => {
    const id = processManager.start("echo polled", process.cwd());
    await waitFor(() => processManager.poll(id).status === "exited");
    const id2 = processManager.start("echo via-tool", process.cwd());
    await new Promise((r) => setTimeout(r, 200));
    const formatted = await execShellPollTool.handler({ id: id2 }, ctx);
    expect(formatted).toContain("状态:");
  });

  it("kills a background process via the tool", async () => {
    const id = processManager.start("sleep 30", process.cwd());
    const out = await execShellKillTool.handler({ id }, ctx);
    expect(out).toContain(id);
    await waitFor(() => processManager.poll(id).status === "exited");
    expect(processManager.poll(id).status).toBe("exited");
  });

  it("declares auto approval", () => {
    expect(execShellPollTool.approval).toBe("auto");
    expect(execShellKillTool.approval).toBe("auto");
    expect(execShellPollTool.name).toBe("exec_shell_poll");
    expect(execShellKillTool.name).toBe("exec_shell_kill");
  });
});
