import { describe, it, expect, afterEach } from "vitest";
import { execShellTool, cleanupDbBackups } from "./exec_shell.js";
import { processManager } from "./process_manager.js";
import { createForegroundRegistry } from "../tui/foreground_registry.js";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

afterEach(() => processManager.reset());
const ctx = { workspaceRoot: process.cwd() };

describe("Bash tool", () => {
  it("runs a foreground command and returns stdout + exit code", async () => {
    const out = await execShellTool.handler({ command: "echo fg-hello" }, ctx);
    expect(out).toContain("fg-hello");
    expect(out).toContain("[exit 0,");
  });

  it("reports a non-zero exit code without throwing", async () => {
    const out = await execShellTool.handler({ command: "sh -c 'exit 3'" }, ctx);
    expect(out).toContain("[exit 3,");
  });

  it("starts a background process and returns its id with auto-notify hint", async () => {
    const out = await execShellTool.handler({ command: "echo bg", background: true }, ctx);
    expect(out).toMatch(/id=proc-\d+/);
    expect(out).toContain("自动通知");
  });

  it("前台执行(即便非零退出)清空 pendingUnverifiedWrites——任何一次真实执行都算已有反馈,不判定针对哪个文件", async () => {
    const pendingUnverifiedWrites = new Set<string>(["/app/compress.rs"]);
    await execShellTool.handler({ command: "sh -c 'exit 1'" }, { ...ctx, pendingUnverifiedWrites });
    expect(pendingUnverifiedWrites.size).toBe(0);
  });

  it("后台命令一发起就清空 pendingUnverifiedWrites(不等命令跑完)", async () => {
    const pendingUnverifiedWrites = new Set<string>(["/app/compress.rs"]);
    await execShellTool.handler({ command: "echo bg", background: true }, { ...ctx, pendingUnverifiedWrites });
    expect(pendingUnverifiedWrites.size).toBe(0);
  });

  it("sleep 拦截/小文件拦截这类【根本没有真正执行】的早退分支,不清空 pendingUnverifiedWrites", async () => {
    const pendingUnverifiedWrites = new Set<string>(["/app/compress.rs"]);
    const out = await execShellTool.handler({ command: "sleep 15" }, { ...ctx, pendingUnverifiedWrites });
    expect(out).toContain("不要用 sleep 阻塞等待");
    expect(pendingUnverifiedWrites.size).toBe(1); // 命令被拦截、从未真正执行,不能算"已有反馈"
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
    expect(out).toContain("[已中断,");
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
    expect(out).toContain("[exit 0,");
    expect(elapsed).toBeLessThan(3000); // 远小于孙进程的 30s 存活时间,证明没有卡在等 close
  });

  it("apt-get 类命令被中断打断 → 自动尝试 dpkg --configure -a 修复,并在输出里说明", async () => {
    // 根因(真实撞见:terminal-bench merge-diff-arc-agi-task 任务,算法本身完全正确,纯因为
    // 早先一次 apt-get 被前台超时强杀在事务中途、dpkg 卡在 interrupted 态,导致 verifier
    // 自己装 curl/uv 也失败、pytest 从未跑起来,判了 0 分——这是"apt-get被中断打断损坏dpkg"
    // 这个具体机制的第2次独立复现,不是孤立事件)。去掉 timeout 机制后,DAO 已经不会再主动
    // 打断前台命令,唯一还会触发这条恢复路径的是 abort(ESC/信号中断)——用 AbortController
    // 模拟,造一个名字叫 apt-get、实际会跑超过 abort 时机的假可执行文件、塞进 PATH 最前面,
    // 不依赖真实 apt-get/dpkg 是否装在测试机上——断言只关心"检测到 abort+命令名匹配 →
    // 触发了自动恢复尝试并在输出里说明",不关心 dpkg 命令本身在这台机器上成不成功。
    const fakeBin = mkdtempSync(path.join(tmpdir(), "exec-shell-test-"));
    writeFileSync(path.join(fakeBin, "apt-get"), "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
    const controller = new AbortController();
    const p = execShellTool.handler(
      { command: `PATH="${fakeBin}:$PATH" apt-get install foo` },
      { ...ctx, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 100);
    const out = await p;
    expect(out).toContain("[已中断,");
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
      const controller = new AbortController();
      const p = execShellTool.handler(
        { command: "apt-get install foo" },
        { ...ctx, signal: controller.signal },
      );
      setTimeout(() => controller.abort(), 100);
      const out = await p;
      expect(out).toContain("[自动恢复]");
      expect(out).not.toContain("[自动恢复失败]");
      // 计数文件应该是 2:第一次失败 + 重试一次成功。
      expect(readFileSync(counterFile, "utf8").trim()).toBe("2");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("非包管理器命令被中断 → 不触发 dpkg 自动恢复", async () => {
    const controller = new AbortController();
    const p = execShellTool.handler(
      { command: "sh -c 'sleep 5'" },
      { ...ctx, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 100);
    const out = await p;
    expect(out).toContain("[已中断,");
    expect(out).not.toContain("自动恢复");
    expect(out).not.toContain("dpkg");
  });

  it("纯 sleep 命令被拦截(反 sleep 探测,阈值 ≥2 秒)", async () => {
    const out = await execShellTool.handler({ command: "sleep 15" }, ctx);
    expect(out).toContain("不要用 sleep");
    expect(out).toContain("自动通知");
    expect(out).not.toContain("[exit");
  });

  it("sleep 2 秒也被拦截(阈值 ≥2,与 CC 对齐)", async () => {
    const out = await execShellTool.handler({ command: "sleep 2" }, ctx);
    expect(out).toContain("不要用 sleep");
  });

  it("sleep 1 秒不拦截(低于阈值,正常执行)", async () => {
    const out = await execShellTool.handler({ command: "sleep 1" }, ctx);
    expect(out).not.toContain("不要用 sleep");
  });

  it("复合 sleep 命令不拦截(如 sleep && echo)", async () => {
    const out = await execShellTool.handler({ command: "sleep 0.1 && echo done" }, ctx);
    expect(out).toContain("done");
    expect(out).toContain("[exit 0,");
  });

  it("python3 -c 命令里引用了一个存在且不大的文件 → 第一次就拦下,命令不执行", async () => {
    const fakeBin = mkdtempSync(path.join(tmpdir(), "exec-shell-test-"));
    const dataFile = path.join(fakeBin, "small.jsonl");
    writeFileSync(dataFile, '{"a":1}\n{"a":2}\n');
    const out = await execShellTool.handler(
      { command: `python3 -c "import json; open('${dataFile}')"` },
      ctx,
    );
    expect(out).toContain("不用写 python 脚本");
    expect(out).toContain("small.jsonl");
    expect(out).not.toContain("[exit");
  });

  it("python3 -c 命令没引用任何看得出来的小文件路径 → 不拦,正常走原有 streak 逻辑", async () => {
    await execShellTool.handler({ command: "echo reset-streak" }, ctx);
    const out = await execShellTool.handler({ command: 'python3 -c "print(sum(range(10)))"' }, ctx);
    expect(out).not.toContain("不用写 python 脚本");
  });

  it("连续 3 次 python3 -c 内联脚本触发一次提醒,之后同一 streak 内不重复念叨", async () => {
    // 不关心 python3 是否真的装在测试机上——命令是否匹配"python3 -c"这个反模式跟它
    // 实际能不能跑成功无关,断言只看提醒文案有没有按第 3 次触发、第 4 次不重复。
    await execShellTool.handler({ command: "echo reset-streak" }, ctx); // 确保从 0 开始数
    const out1 = await execShellTool.handler({ command: 'python3 -c "print(1)"' }, ctx);
    expect(out1).not.toContain("[提示]");
    const out2 = await execShellTool.handler({ command: 'python3 -c "print(2)"' }, ctx);
    expect(out2).not.toContain("[提示]");
    const out3 = await execShellTool.handler({ command: 'python3 -c "print(3)"' }, ctx);
    expect(out3).toContain("[提示]");
    expect(out3).toContain("Grep");
    const out4 = await execShellTool.handler({ command: 'python3 -c "print(4)"' }, ctx);
    expect(out4).not.toContain("[提示]");
  });

  it("换成非 python 命令后计数清零,下次连续 3 次 python -c 才重新触发提醒", async () => {
    await execShellTool.handler({ command: "echo reset-streak" }, ctx); // 清掉上一条用例遗留的 streak/nudged 状态
    await execShellTool.handler({ command: 'python -c "print(1)"' }, ctx);
    await execShellTool.handler({ command: 'python -c "print(2)"' }, ctx);
    const primed = await execShellTool.handler({ command: 'python -c "print(3)"' }, ctx);
    expect(primed).toContain("[提示]");
    await execShellTool.handler({ command: "echo reset-streak" }, ctx);
    const out = await execShellTool.handler({ command: 'python -c "print(1)"' }, ctx);
    expect(out).not.toContain("[提示]");
  });

  describe("数据库文件执行前自动备份", () => {
    it("命令引用了存在的 .db 主文件 → 执行前自动备份主文件和它的 WAL/SHM/journal 边车文件", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "exec-shell-test-"));
      const main = path.join(dir, "main.db");
      const wal = path.join(dir, "main.db-wal");
      writeFileSync(main, "main-content");
      writeFileSync(wal, "wal-content");
      // 命令文本里只提到了 main.db,没提到 main.db-wal——边车文件要能被隐式识别并备份。
      const out = await execShellTool.handler({ command: `wc -c ${main}` }, ctx);
      expect(out).toContain("[自动备份]");
      expect(out).toContain("main.db");
      expect(readFileSync(main + ".dao-backup", "utf8")).toBe("main-content");
      expect(readFileSync(wal + ".dao-backup", "utf8")).toBe("wal-content");
    });

    it("已经备份过的文件不重复覆盖(保留最早的干净版本)", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "exec-shell-test-"));
      const main = path.join(dir, "app.sqlite3");
      writeFileSync(main, "v1");
      await execShellTool.handler({ command: `wc -c ${main}` }, ctx);
      expect(readFileSync(main + ".dao-backup", "utf8")).toBe("v1");
      writeFileSync(main, "v2-corrupted-by-something-else");
      const out2 = await execShellTool.handler({ command: `wc -c ${main}` }, ctx);
      expect(out2).not.toContain("[自动备份]"); // 已备份过,这次不该再触发/覆盖
      expect(readFileSync(main + ".dao-backup", "utf8")).toBe("v1"); // 备份仍是最早的干净版本
    });

    it("命令没有引用任何数据库文件 → 不触发,不额外产生备份文件", async () => {
      const out = await execShellTool.handler({ command: "echo no-db-here" }, ctx);
      expect(out).not.toContain("[自动备份]");
    });

    it("python3 -c 内联脚本里引用了数据库文件也能识别(不局限于普通 shell 命令)", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "exec-shell-test-"));
      const main = path.join(dir, "main.db");
      writeFileSync(main, "content");
      // 这段脚本引用的其它路径不是"小文本文件",不会被 python-inline 小文件拦截提前挡掉。
      const out = await execShellTool.handler(
        { command: `python3 -c "import sqlite3; sqlite3.connect('${main}').execute('SELECT 1')"` },
        ctx,
      );
      expect(out).toContain("[自动备份]");
      expect(readFileSync(main + ".dao-backup", "utf8")).toBe("content");
    });

    it("被 python-inline 小文件规则提前拦截、命令根本没执行时 → 不做无意义的备份", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "exec-shell-test-"));
      const small = path.join(dir, "notes.txt");
      writeFileSync(small, "hello");
      const out = await execShellTool.handler(
        { command: `python3 -c "open('${small}')"` },
        ctx,
      );
      expect(out).toContain("不用写 python 脚本"); // 确认真的被小文件规则拦下、命令未执行
      expect(out).not.toContain("[自动备份]");
    });

    it("Redis/Firebird/KeePass/dBase 等同构扩展名也能识别", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "exec-shell-test-"));
      for (const name of ["dump.rdb", "log.aof", "vault.kdbx", "table.dbf"]) {
        const f = path.join(dir, name);
        writeFileSync(f, "content");
        const out = await execShellTool.handler({ command: `wc -c ${f}` }, ctx);
        expect(out).toContain("[自动备份]");
        expect(readFileSync(f + ".dao-backup", "utf8")).toBe("content");
      }
    });

    it("回归:'db' 是 'db3'/'dbf' 的前缀,不能被短的那个抢先截断匹配掉", async () => {
      // 之前的写法(扩展名后面没加边界)会把 "state.db3" 错误截断匹配成 "state.db",
      // 按不存在的文件名去 statSync,找不到就被判定"不是备份目标"、什么也没做。
      const dir = mkdtempSync(path.join(tmpdir(), "exec-shell-test-"));
      const f = path.join(dir, "state.db3");
      writeFileSync(f, "content");
      const out = await execShellTool.handler({ command: `wc -c ${f}` }, ctx);
      expect(out).toContain("[自动备份]");
      expect(readFileSync(f + ".dao-backup", "utf8")).toBe("content");
    });
  });

  describe("会话结束清理 .dao-backup 文件", () => {
    it("递归清理工作区下所有 .dao-backup 文件,不影响其它文件", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "exec-shell-test-"));
      const sub = path.join(dir, "nested");
      mkdirSync(sub);
      writeFileSync(path.join(dir, "main.db.dao-backup"), "backup1");
      writeFileSync(path.join(sub, "app.sqlite3.dao-backup"), "backup2");
      writeFileSync(path.join(dir, "keep.txt"), "keep-me");
      const n = await cleanupDbBackups(dir);
      expect(n).toBe(2);
      expect(existsSync(path.join(dir, "main.db.dao-backup"))).toBe(false);
      expect(existsSync(path.join(sub, "app.sqlite3.dao-backup"))).toBe(false);
      expect(existsSync(path.join(dir, "keep.txt"))).toBe(true);
    });

    it("没有任何 .dao-backup 文件时返回 0,不报错", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "exec-shell-test-"));
      writeFileSync(path.join(dir, "normal.txt"), "hi");
      const n = await cleanupDbBackups(dir);
      expect(n).toBe(0);
      expect(readFileSync(path.join(dir, "normal.txt"), "utf8")).toBe("hi");
    });
  });

  it("declares exec capability and required approval", () => {
    expect(execShellTool.capability).toBe("exec");
    expect(execShellTool.approval).toBe("required");
    expect(execShellTool.name).toBe("Bash");
  });

  describe("Ctrl+B 转后台", () => {
    it("注册表触发转后台回调后,工具调用立即返回已转后台文本,不等命令跑完", async () => {
      const registry = createForegroundRegistry();
      const start = Date.now();
      const resultPromise = execShellTool.handler(
        { command: "true && sleep 5 && echo done" }, // 前缀 "true &&" 避开反 sleep 轮询拦截(该拦截只匹配【以 sleep 开头】的命令)
        { ...ctx, foregroundRegistry: registry },
      );
      // 等一小段时间确保命令已经真正 spawn 起来,再模拟用户按 Ctrl+B
      await new Promise((r) => setTimeout(r, 100));
      const n = registry.convertAll();
      expect(n).toBe(1);
      const result = await resultPromise;
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(4000); // 没有傻等 5 秒
      expect(result).toContain("已转后台");
      expect(processManager.runningCount()).toBe(1); // 进程被 processManager 接管、还在跑
    });

    it("命令跑得很快、自己结束了之后,注册表里已经没有它了(convertAll 触发不到)", async () => {
      const registry = createForegroundRegistry();
      const result = await execShellTool.handler(
        { command: "echo fast" },
        { ...ctx, foregroundRegistry: registry },
      );
      expect(result).toContain("fast");
      expect(registry.convertAll()).toBe(0); // 已经在 finish() 里反注册了
    });

    // 端到端验证(计划 Task 6):转后台不是"打断"——命令在后台完整跑完,期间产出的全部输出都要能读到,
    // 一个字节都不能因为转后台这个动作丢失。这是这个功能最核心的价值点,必须亲眼断言到,不能只信任
    // 上面两条单测里"进程还在跑"这个中间状态。
    it("真实验证:转后台之后命令在后台完整跑完,期间的全部输出都读得到,不是被打断", async () => {
      const registry = createForegroundRegistry();
      const resultPromise = execShellTool.handler(
        { command: "true && (echo tick-1; sleep 0.3; echo tick-2; sleep 0.3; echo tick-3; sleep 0.3; echo ALL_DONE)" },
        { ...ctx, foregroundRegistry: registry },
      );
      await new Promise((r) => setTimeout(r, 100)); // 等 tick-1 大概率已经产出,再按 Ctrl+B
      registry.convertAll();
      const result = await resultPromise;
      const idMatch = /已转后台\(id=(proc-\d+)\)/.exec(result);
      expect(idMatch).not.toBeNull();
      const id = idMatch![1]!;

      // 等它在后台真正跑完(不是又傻等,是轮询到 exited 为止,上限给够)
      const start = Date.now();
      let combined = "";
      let status: "running" | "exited" = "running";
      while (Date.now() - start < 3000) {
        const r = processManager.poll(id);
        combined += r.stdout;
        status = r.status;
        if (status === "exited") break;
        await new Promise((res) => setTimeout(res, 50));
      }
      expect(status).toBe("exited");
      expect(combined).toContain("tick-1");
      expect(combined).toContain("tick-2");
      expect(combined).toContain("tick-3");
      expect(combined).toContain("ALL_DONE"); // 转后台之后产出的内容,证明命令没有被打断,是真的在后台跑完的
    });
  });
});
