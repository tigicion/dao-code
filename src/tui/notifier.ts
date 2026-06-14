import { execFile } from "node:child_process";

// P3-63 桌面通知:长任务/回合完成时弹系统通知(你走开了也能知道)。best-effort,无 GUI/binary 静默失败。
// DAO_NO_NOTIFY=1 关闭。
export function notify(title: string, message: string): void {
  if (process.env.DAO_NO_NOTIFY === "1") return;
  const cb = () => {}; // 忽略一切错误
  try {
    if (process.platform === "darwin") {
      execFile("osascript", ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`], cb);
    } else if (process.platform === "linux") {
      execFile("notify-send", [title, message], cb);
    } else if (process.platform === "win32") {
      const ps = `[reflection.assembly]::loadwithpartialname('System.Windows.Forms');$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;$n.ShowBalloonTip(5000,${JSON.stringify(title)},${JSON.stringify(message)},'Info')`;
      execFile("powershell", ["-NoProfile", "-Command", ps], cb);
    }
  } catch { /* 无通知能力 → 忽略 */ }
}
