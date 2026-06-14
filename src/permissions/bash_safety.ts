import { splitBashCommands } from "./rules.js";

// S2.1 危险命令黑名单:识别"不可逆破坏 / 远程代码执行 / 提权"类 shell 命令。
// 命中者即便在 auto/yolo 下也强制人工确认(见 engine.mustConfirm + gate auto 路径)。
// 启发式(非完备),宁可多问一次:复合命令逐段判定,任一段命中即返回原因。
function dangerSegment(s: string): string | null {
  // rm 递归 + 危险目标(根/家目录/通配)——相对路径如 node_modules 不触发
  if (/\brm\b/i.test(s) && /(^|\s)-\S*r/i.test(s)) {
    if (/\s(\/|~|\$home)(\s|\/|$)/i.test(s) || /\s\/\*(\s|$)/.test(s) || /(^|\s)\*(\s|$)/.test(s) || /\s~\//i.test(s)) return "rm 递归删除根/家目录/通配,可能毁坏系统";
  }
  // 写裸磁盘设备 / 格式化
  if (/\b(dd|tee)\b[^|]*of=\s*\/dev\/(sd|nvme|disk|hd)/i.test(s) || />\s*\/dev\/(sd|nvme|disk|hd)/i.test(s)) return "写入裸磁盘设备";
  if (/\bmkfs(\.\w+)?\b/i.test(s)) return "格式化文件系统";
  // 递归改权限/属主到危险目标
  if (/\bchmod\s+-?R?\s*0?777\b/i.test(s) || (/\bchmod\b/i.test(s) && /(^|\s)-\S*R/.test(s) && /\s(\/|~)(\s|\/|$)/i.test(s))) return "递归/全开 chmod,可能破坏权限";
  if (/\bchown\b/i.test(s) && /(^|\s)-\S*R/.test(s) && /\s(\/|~)(\s|\/|$)/i.test(s)) return "递归 chown 到根/家目录";
  // 覆盖系统配置
  if (/>\s*\/etc\//i.test(s)) return "覆盖 /etc 系统配置";
  // 提权 / 动态执行
  if (/(^|\s)sudo\b/i.test(s)) return "sudo 提权";
  if (/(^|\s)eval\b/i.test(s)) return "eval 动态执行";
  return null;
}

// 返回危险原因(命中)或 null(安全)。
export function isDangerousCommand(command: string): string | null {
  if (typeof command !== "string" || !command.trim()) return null;
  // 管道把下载/输出喂给 shell + fork bomb:在整串上判(splitBashCommands 会把 | 拆开)。
  if (/\b(curl|wget|fetch)\b[\s\S]*\|\s*(sudo\s+)?(sh|bash|zsh|fish|python|perl|node|ruby)\b/i.test(command)) return "下载内容直接管道执行(远程代码执行风险)";
  if (/:\(\)\{:\|:&\};:/.test(command.replace(/\s/g, ""))) return "fork bomb(耗尽进程)";
  for (const seg of splitBashCommands(command)) {
    const r = dangerSegment(seg.trim());
    if (r) return r;
  }
  return null;
}
