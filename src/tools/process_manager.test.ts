import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { processManager } from "./process_manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url)); // ESM 无内置 __dirname

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

let workDir: string;

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "dao-bgproc-"));
});

afterEach(async () => {
  processManager.reset();
  await fs.rm(workDir, { recursive: true, force: true });
});

describe("processManager", () => {
  it("runs a background command and collects its output until exit", async () => {
    const id = processManager.start("echo bg-hello", workDir);
    expect(id).toMatch(/^proc-\d+$/);
    const r = await waitExited(id);
    expect(r.status).toBe("exited");
    expect(r.stdout).toContain("bg-hello");
    expect(r.exitCode).toBe(0);
  });

  it("drains buffered output on each poll (reads only new bytes since last read)", async () => {
    const id = processManager.start("echo one", workDir);
    await waitExited(id);
    const again = processManager.poll(id);
    expect(again.stdout).toBe("");
  });

  it("kills a long-running process", async () => {
    const id = processManager.start("sleep 30", workDir);
    processManager.kill(id);
    const r = await waitExited(id);
    expect(r.status).toBe("exited");
  });

  it("throws on unknown id", () => {
    expect(() => processManager.poll("proc-999")).toThrow(/未知后台进程/);
    expect(() => processManager.kill("proc-999")).toThrow(/未知后台进程/);
  });

  // 回归测试:此前用 pipe 收集 stdout/stderr,父进程(DAO 自身)退出时 pipe 被关闭,
  // 子进程下次写 stdout 就会 SIGPIPE 死掉——这是"服务在 DAO 自测时活着、退出后再连就没了"的真实成因。
  // 这里真实起一个独立子进程(模拟 DAO 自身的一次调用),让它内部再起一个后台孙进程后自己正常退出,
  // 断言孙进程在"父进程"(这个独立子进程)已经彻底退出之后依然存活、且日志仍在持续写入。
  it("后台进程在启动它的父进程退出后依然存活(真实跨进程验证,不只是本进程内的 mock)", async () => {
    const script = path.join(workDir, "spawn-and-exit.ts");
    const pidFile = path.join(workDir, "grandchild.pid");
    const logFile = path.join(workDir, "grandchild-log-path.txt");
    await fs.writeFile(
      script,
      `
      import { processManager } from ${JSON.stringify(path.resolve(__dirname, "process_manager.ts"))};
      import { writeFileSync } from "node:fs";
      (async () => {
        const id = processManager.start("sleep 0.3 && echo alive-after-parent-exit && sleep 5", ${JSON.stringify(workDir)});
        // 给一点时间让子进程真正 spawn 出来、拿到系统 pid,再读内部状态。
        await new Promise((r) => setTimeout(r, 100));
        const p = (processManager as any).procs.get(id);
        writeFileSync(${JSON.stringify(pidFile)}, String(p.child.pid));
        writeFileSync(${JSON.stringify(logFile)}, p.stdoutPath);
        process.exit(0); // 模拟 DAO 自身这一轮调用正常结束退出
      })();
      `,
    );
    const tsx = path.resolve(__dirname, "../../node_modules/.bin/tsx");
    const res = spawnSync(tsx, [script], { encoding: "utf8", timeout: 10000 });
    expect(res.status).toBe(0);

    const pid = Number(await fs.readFile(pidFile, "utf8"));
    const stdoutPath = await fs.readFile(logFile, "utf8");

    // "父进程"(那个独立子进程)此刻已经彻底退出了(spawnSync 已返回)。
    // 孙进程理应仍然存活——用信号 0 探活(不实际发信号,只检查进程是否还在)。
    expect(() => process.kill(pid, 0)).not.toThrow();

    // 等它跑完那句 echo,确认日志文件在父进程退出之后依然被正常写入(没有半路 SIGPIPE 崩掉)。
    const start = Date.now();
    let content = "";
    while (Date.now() - start < 3000) {
      content = await fs.readFile(stdoutPath, "utf8").catch(() => "");
      if (content.includes("alive-after-parent-exit")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(content).toContain("alive-after-parent-exit");

    // 收尾,别留下真跑着的进程。
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
  });
});
