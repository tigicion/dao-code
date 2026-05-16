import { describe, it, expect, afterEach } from "vitest";
import { processManager } from "./process_manager.js";

async function waitExited(id: string, timeoutMs = 3000) {
  const start = Date.now();
  let stdout = "";
  while (Date.now() - start < timeoutMs) {
    const r = processManager.poll(id);
    stdout += r.stdout;
    if (r.status === "exited") return { ...r, stdout };
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error("timed out waiting for exit");
}

afterEach(() => processManager.reset());

describe("processManager", () => {
  it("runs a background command and collects its output until exit", async () => {
    const id = processManager.start("echo bg-hello", process.cwd());
    expect(id).toMatch(/^proc-\d+$/);
    const r = await waitExited(id);
    expect(r.status).toBe("exited");
    expect(r.stdout).toContain("bg-hello");
    expect(r.exitCode).toBe(0);
  });

  it("drains buffered output on each poll", async () => {
    const id = processManager.start("echo one", process.cwd());
    await waitExited(id);
    const again = processManager.poll(id);
    expect(again.stdout).toBe("");
  });

  it("kills a long-running process", async () => {
    const id = processManager.start("sleep 30", process.cwd());
    processManager.kill(id);
    const r = await waitExited(id);
    expect(r.status).toBe("exited");
  });

  it("throws on unknown id", () => {
    expect(() => processManager.poll("proc-999")).toThrow(/未知后台进程/);
    expect(() => processManager.kill("proc-999")).toThrow(/未知后台进程/);
  });
});
