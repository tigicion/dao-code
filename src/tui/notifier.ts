import { execFile } from "node:child_process";

// P3-63 桌面通知:长任务/回合完成时弹系统通知(你走开了也能知道)。best-effort,无 GUI/binary 静默失败。
// DAO_NO_NOTIFY=1 关闭。

// TERM_PROGRAM → 常见终端应用的 macOS bundle id,给 terminal-notifier 的 -activate 用,让点击通知
// 精确聚焦回你实际在用的那个终端。
// 这只对 terminal-notifier 有效——它是个有自己 bundle 身份的编译工具,-activate 是它原生实现的能力。
// 裸 osascript 的 display notification 做不到同样效果:查过 Apple 官方 Mac Automation Scripting Guide,
// 通知的归属只跟"实际执行这段 AppleScript 的进程"有关(命令行调用时是 osascript,系统挂到脚本编辑器
// 名下),跟脚本里写不写 tell application id 无关——曾经想用 `tell application id X to display
// notification` 让通知"看起来"归属到目标终端,实测/查文档证实这个包装完全不生效,点击仍会打开脚本编辑器,
// 已经撤回。terminal-notifier 没装时没有真正能绕开这个限制的办法,老实退回裸 osascript,只保证能弹出
// 通知,不保证点击行为;想要点击聚焦终端,需要 `brew install terminal-notifier`。
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
        // 仍能弹通知,只是点击不保证聚焦到终端(见上方注释——裸 osascript 做不到,不是没写对)。
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
