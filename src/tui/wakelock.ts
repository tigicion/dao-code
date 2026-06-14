import { spawn, type ChildProcess } from "node:child_process";

// P3-63 防休眠:长任务跑的时候别让机器睡过去(否则自主推进中断)。
// 回合开始 acquire、结束调返回的 release 释放。best-effort,无 binary 静默退化为 no-op。DAO_NO_WAKELOCK=1 关闭。
export function acquireWakeLock(): () => void {
  if (process.env.DAO_NO_WAKELOCK === "1") return () => {};
  let child: ChildProcess | undefined;
  try {
    if (process.platform === "darwin") {
      child = spawn("caffeinate", ["-i"], { stdio: "ignore" }); // 阻止 idle 休眠,进程存活期间有效
    } else if (process.platform === "linux") {
      child = spawn("systemd-inhibit", ["--what=idle:sleep", "--why=dao 长任务", "--mode=block", "sleep", "infinity"], { stdio: "ignore" });
    }
  } catch { child = undefined; }
  child?.on("error", () => { /* 无 binary → 忽略 */ });
  let released = false;
  return () => { if (released) return; released = true; try { child?.kill(); } catch { /* 已退出 */ } };
}
