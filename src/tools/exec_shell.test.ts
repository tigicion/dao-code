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

  it("命令本身已退出、但拉起的孙进程还占着继承的 stdout 管道不放 → 仍能及时收尾,不会永久卡死", async () => {
    // 根因(真实撞见:terminal-bench mailman 任务,启动 postfix/mailman3 服务后 exec_shell
    // 卡死超过1500秒,直到外层 harbor 硬超时才被杀):Node 的 child.on("close") 要等 stdio
    // 流全部看到 EOF 才触发。命令本身(shell)很快退出了,但如果它拉起了一个没把 stdout/
    // stderr 重定向走的后台进程(继承了父进程管道),这个孙进程只要还活着就一直占着管道,
    // "close" 永远不会来——旧写法只监听 "close",Promise 因此永久卡住,即便前台超时/SIGTERM
    // 已经正确杀掉了能杀到的那部分进程组。这里用一个存活30秒的后台进程模拟"长期运行的服务"
    // (故意选一个远超测试超时的时长,不给"碰巧很快退出"留侥幸空间),断言 exec_shell 仍然
    // 在几百毫秒内正常收尾,而不是卡到 30 秒。
    const start = Date.now();
    const out = await execShellTool.handler(
      { command: "(sleep 30 &); echo shell-done" },
      ctx,
    );
    const elapsed = Date.now() - start;
    expect(out).toContain("shell-done");
    expect(out).toContain("[exit 0]");
    expect(elapsed).toBeLessThan(3000); // 远小于孙进程的 30s 存活时间,证明没有卡在等 close
  });

  it("declares exec capability and required approval", () => {
    expect(execShellTool.capability).toBe("exec");
    expect(execShellTool.approval).toBe("required");
    expect(execShellTool.name).toBe("exec_shell");
  });
});
