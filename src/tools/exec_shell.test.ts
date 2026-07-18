import { describe, it, expect, afterEach } from "vitest";
import { execShellTool } from "./exec_shell.js";
import { processManager } from "./process_manager.js";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

afterEach(() => processManager.reset());
const ctx = { workspaceRoot: process.cwd() };

describe("Bash tool", () => {
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
      { command: "sh -c 'sleep 5'" },
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
    // 根因(真实撞见:terminal-bench mailman 任务,启动 postfix/mailman3 服务后 Bash
    // 卡死超过1500秒,直到外层 harbor 硬超时才被杀):Node 的 child.on("close") 要等 stdio
    // 流全部看到 EOF 才触发。命令本身(shell)很快退出了,但如果它拉起了一个没把 stdout/
    // stderr 重定向走的后台进程(继承了父进程管道),这个孙进程只要还活着就一直占着管道,
    // "close" 永远不会来——旧写法只监听 "close",Promise 因此永久卡住,即便前台超时/SIGTERM
    // 已经正确杀掉了能杀到的那部分进程组。这里用一个存活30秒的后台进程模拟"长期运行的服务"
    // (故意选一个远超测试超时的时长,不给"碰巧很快退出"留侥幸空间),断言 Bash 仍然
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

  it("apt-get 类命令被超时打断 → 自动尝试 dpkg --configure -a 修复,并在输出里说明", async () => {
    // 根因(真实撞见:terminal-bench merge-diff-arc-agi-task 任务,算法本身完全正确,纯因为
    // 早先一次 apt-get 被 120s 超时强杀在事务中途、dpkg 卡在 interrupted 态,导致 verifier
    // 自己装 curl/uv 也失败、pytest 从未跑起来,判了 0 分——这是"apt-get被超时打断损坏dpkg"
    // 这个具体机制的第2次独立复现,不是孤立事件)。造一个名字叫 apt-get、实际会跑超过
    // timeout 的假可执行文件、塞进 PATH 最前面,来触发这条路径,不依赖真实 apt-get/dpkg
    // 是否装在测试机上——断言只关心"检测到超时+命令名匹配 → 触发了自动恢复尝试并在输出
    // 里说明",不关心 dpkg 命令本身在这台机器上成不成功。
    const fakeBin = mkdtempSync(path.join(tmpdir(), "exec-shell-test-"));
    writeFileSync(path.join(fakeBin, "apt-get"), "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
    const out = await execShellTool.handler(
      { command: `PATH="${fakeBin}:$PATH" apt-get install foo`, timeout: 100 },
      ctx,
    );
    expect(out).toContain("[超时,已终止]");
    expect(out).toMatch(/\[自动恢复(失败)?\]/);
    expect(out).toContain("dpkg --configure -a");
  });

  it("dpkg --configure -a 首次恢复尝试失败 → 重试一次,重试成功则不报'自动恢复失败'", async () => {
    // 根因(真实撞见:merge-diff-arc-agi-task 复测时,第一次自动恢复尝试就失败了——
    // 猜测是刚被杀掉的包管理器进程还没释放 dpkg 锁,恢复命令撞了个空、白白放过一次本可
    // 恢复的场景)。造一个假 dpkg,用计数文件模拟"第一次调用失败(锁还没释放)、
    // 第二次调用成功(锁已释放)",断言重试后最终拿到的是"[自动恢复]"而不是
    // "[自动恢复失败]"——证明重试逻辑真的在补救首次失败。
    const fakeBin = mkdtempSync(path.join(tmpdir(), "exec-shell-test-"));
    const counterFile = path.join(fakeBin, "dpkg.count");
    writeFileSync(path.join(fakeBin, "apt-get"), "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
    writeFileSync(
      path.join(fakeBin, "dpkg"),
      `#!/bin/sh\n` +
        `n=$(cat "${counterFile}" 2>/dev/null || echo 0)\n` +
        `n=$((n + 1))\n` +
        `echo "$n" > "${counterFile}"\n` +
        `if [ "$n" -eq 1 ]; then echo "dpkg: error: dpkg status database is locked" >&2; exit 1; fi\n` +
        `exit 0\n`,
      { mode: 0o755 },
    );
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath}`;
    try {
      const out = await execShellTool.handler(
        { command: "apt-get install foo", timeout: 100 },
        ctx,
      );
      expect(out).toContain("[自动恢复]");
      expect(out).not.toContain("[自动恢复失败]");
      // 计数文件应该是 2:第一次失败 + 重试一次成功。
      expect(readFileSync(counterFile, "utf8").trim()).toBe("2");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("非包管理器命令超时 → 不触发 dpkg 自动恢复", async () => {
    const out = await execShellTool.handler({ command: "sh -c 'sleep 5'", timeout: 100 }, ctx);
    expect(out).toContain("[超时,已终止]");
    expect(out).not.toContain("自动恢复");
    expect(out).not.toContain("dpkg");
  });

  it("纯 sleep 命令被拦截(反 sleep 轮询后台任务)", async () => {
    const out = await execShellTool.handler({ command: "sleep 15" }, ctx);
    expect(out).toContain("不要用 sleep");
    expect(out).not.toContain("[exit");
  });

  it("复合 sleep 命令不拦截(如 sleep && echo)", async () => {
    const out = await execShellTool.handler({ command: "sleep 0.1 && echo done" }, ctx);
    expect(out).toContain("done");
    expect(out).toContain("[exit 0]");
  });

  it("declares exec capability and required approval", () => {
    expect(execShellTool.capability).toBe("exec");
    expect(execShellTool.approval).toBe("required");
    expect(execShellTool.name).toBe("Bash");
  });
});
