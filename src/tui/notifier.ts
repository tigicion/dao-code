import { execFile } from "node:child_process";

// P3-63 桌面通知:长任务/回合完成时弹系统通知(你走开了也能知道)。best-effort,无 GUI/binary 静默失败。
// DAO_NO_NOTIFY=1 关闭。

// TERM_PROGRAM → 常见终端应用的 macOS bundle id,给 terminal-notifier 的 -activate 用,让点击通知
// 精确聚焦回你实际在用的那个终端——修复纯 osascript display notification 点击行为不稳定的问题
// (它没有真实 bundle 身份,macOS 有时把它附着到 Finder,有时干脆点了没反应)。识别不出就不建议用
// terminal-notifier 的 -activate(没有目标可聚焦,退回 osascript 一样能弹通知)。
const TERM_BUNDLE_IDS: Record<string, string> = {
  Apple_Terminal: "com.apple.Terminal",
  "iTerm.app": "com.googlecode.iterm2",
  vscode: "com.microsoft.VSCode",
  WarpTerminal: "dev.warp.Warp-Stable",
  Hyper: "co.zeit.hyper",
  ghostty: "com.mitchellh.ghostty",
  Tabby: "org.tabby",
};

export function notify(
  title: string,
  message: string,
  opts?: { exec?: typeof execFile; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform },
): void {
  const env = opts?.env ?? process.env;
  if (env.DAO_NO_NOTIFY === "1") return;
  const exec = opts?.exec ?? execFile;
  const platform = opts?.platform ?? process.platform;
  const cb = () => {}; // 忽略一切错误
  try {
    if (platform === "darwin") {
      const osascriptNotify = () =>
        exec("osascript", ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`], cb);
      const bundleId = TERM_BUNDLE_IDS[env.TERM_PROGRAM ?? ""];
      if (bundleId) {
        // 没装 terminal-notifier(Homebrew 包,不是系统自带)→ exec 报错走 catch 回调,退回 osascript,
        // 仍能弹通知,只是点击不保证聚焦到终端。
        exec("terminal-notifier", ["-title", title, "-message", message, "-activate", bundleId], (err) => {
          if (err) osascriptNotify();
        });
      } else {
        osascriptNotify();
      }
    } else if (platform === "linux") {
      exec("notify-send", [title, message], cb);
    } else if (platform === "win32") {
      // ShowBalloonTip 依赖发起进程存活才能真正渲染出来——脚本调完就退出的话,PowerShell 进程
      // 可能在气泡真正弹出前就已经终止,通知经常来不及显示。加 Start-Sleep 撑住(时长跟
      // ShowBalloonTip 的 5000ms 对齐),再释放图标退出。
      const ps = `[reflection.assembly]::loadwithpartialname('System.Windows.Forms');$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;$n.ShowBalloonTip(5000,${JSON.stringify(title)},${JSON.stringify(message)},'Info');Start-Sleep -Seconds 5;$n.Dispose()`;
      exec("powershell", ["-NoProfile", "-Command", ps], cb);
    }
  } catch { /* 无通知能力 → 忽略 */ }
}
