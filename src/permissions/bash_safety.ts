import { splitBashCommands } from "./rules.js";

// S2.1 危险命令黑名单:识别"不可逆破坏 / 远程代码执行 / 提权"类 shell 命令。
// 命中者即便在 auto/yolo 下也强制人工确认(见 engine.mustConfirm + gate auto 路径)。
// 启发式(非完备),宁可多问一次:复合命令逐段判定,任一段命中即返回原因。
function dangerSegment(s: string): string | null {
  // rm 递归 + 危险目标(根/家目录/通配)——相对路径如 node_modules 不触发
  if (/\brm\b/i.test(s) && /(^|\s)-\S*r/i.test(s)) {
    if (/\s(\/|~|\$home)(\s|\/|$)/i.test(s) || /\s\/\*(\s|$)/.test(s) || /(^|\s)\*(\s|$)/.test(s) || /\s~\//i.test(s)) return "rm 递归删除根/家目录/通配,可能毁坏系统";
  }
  // 写裸磁盘设备 / 格式化(含 dd of=/dev/disk)
  if (/\b(dd|tee)\b[^|]*of=\s*\/dev\/(sd|nvme|disk|hd)/i.test(s) || />\s*\/dev\/(sd|nvme|disk|hd)/i.test(s)) return "写入裸磁盘设备";
  if (/\bmkfs(\.\w+)?\b/i.test(s)) return "格式化文件系统";
  // 递归改权限/属主到危险目标
  if (/\bchmod\s+-?R?\s*0?777\b/i.test(s) || (/\bchmod\b/i.test(s) && /(^|\s)-\S*R/.test(s) && /\s(\/|~)(\s|\/|$)/i.test(s))) return "递归/全开 chmod,可能破坏权限";
  // chmod 000:清空权限会让文件/目录不可访问
  if (/\bchmod\s+(-\S+\s+)*0{3,4}\b/i.test(s)) return "chmod 000 清空权限,文件将不可访问";
  if (/\bchown\b/i.test(s) && /(^|\s)-\S*R/.test(s) && /\s(\/|~)(\s|\/|$)/i.test(s)) return "递归 chown 到根/家目录";
  // 递归改属组到根/家目录
  if (/\bchgrp\b/i.test(s) && /(^|\s)-\S*R/.test(s) && /\s(\/|~)(\s|\/|$)/i.test(s)) return "递归 chgrp 到根/家目录";
  // 覆盖系统配置
  if (/>\s*\/etc\//i.test(s)) return "覆盖 /etc 系统配置";
  // :> /important 截断(把现有文件清空)——危险目标:根/家目录/etc/dev
  if (/(^|\s):?\s*>\s*(\/(etc|dev|bin|usr|boot|lib|sbin|var)\/|~\/|\$home)/i.test(s)) return "重定向截断系统/家目录文件";
  // truncate / shred 危险目标(不可逆清空/抹除)
  if (/\btruncate\b/i.test(s) && /\s(\/|~)(\S)/i.test(s)) return "truncate 截断文件(可能清空数据)";
  if (/\bshred\b/i.test(s)) return "shred 不可逆抹除文件";
  // find ... -delete / -exec rm:批量删除,易因路径/通配失误酿灾
  if (/\bfind\b/i.test(s) && (/(^|\s)-delete\b/i.test(s) || /(^|\s)-exec\s+(sudo\s+)?rm\b/i.test(s))) return "find 批量删除(-delete/-exec rm)";
  // git 毁历史 / 丢改动
  if (/\bgit\b/i.test(s) && /\bpush\b/i.test(s) && /(--force(-with-lease)?|(^|\s)-f)\b/i.test(s)) return "git push 强推,可能覆盖远程历史";
  if (/\bgit\b/i.test(s) && /\breset\b/i.test(s) && /--hard\b/i.test(s)) return "git reset --hard,丢弃未提交改动";
  if (/\bgit\b/i.test(s) && /\bclean\b/i.test(s) && /(^|\s)-\S*f/i.test(s) && /(^|\s)-\S*[dx]/i.test(s)) return "git clean -fdx,删除未跟踪文件";
  // 批量杀进程
  if (/\bkill\b\s+-9\s+-1\b/i.test(s) || /\bkill\b\s+-1\b/i.test(s)) return "kill -1/-9 -1,杀光本用户所有进程";
  if (/\bkillall\b/i.test(s)) return "killall 批量杀进程";
  if (/\bpkill\b/i.test(s) && /(^|\s)-9\b/i.test(s)) return "pkill -9 强杀进程";
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

// 只读 shell 命令白名单:这些程序只查看、不改文件/不外联/不提权。
const SAFE_READONLY_CMDS = new Set([
  "ls", "pwd", "cat", "head", "tail", "wc", "file", "stat", "du", "df", "tree",
  "echo", "printf", "which", "type", "whereis", "basename", "dirname", "realpath", "readlink",
  "date", "whoami", "hostname", "uname", "id", "env", "printenv", "uptime", "locale",
  "grep", "egrep", "fgrep", "rg", "ag", "sort", "uniq", "cut", "nl", "column", "comm", "tr", "tac", "rev", "fold", "expand",
  "cksum", "sha1sum", "sha256sum", "md5", "md5sum", "diff", "cmp", "jq", "yq", "xxd", "od", "strings",
]);
// git 只读子命令(push/reset/clean/stash 等改动类不在内)。
const SAFE_GIT_SUB = new Set([
  "status", "log", "diff", "show", "branch", "remote", "tag", "describe", "rev-parse",
  "ls-files", "ls-tree", "blame", "shortlog", "reflog", "whatchanged", "cat-file",
  "for-each-ref", "name-rev", "symbolic-ref", "rev-list", "config",
]);

// 判定一条 shell 命令是否【纯只读、可在 auto 模式快速放行】——保守优先,拿不准就返回 false(交分类器/人工)。
// 仅放行:每个管道段首词都是只读程序;无重定向/命令替换/后台/链式/子shell;非危险命令。
// 不替代敏感目标判定(cat ~/.ssh/id_rsa 由 mustConfirm 拦,调用方应先查 mustConfirm)。
export function isReadOnlyShellCommand(command: string): boolean {
  if (typeof command !== "string") return false;
  const s = command.trim();
  if (!s) return false;
  if (isDangerousCommand(s)) return false; // 双保险
  // 拒绝可能改写/外联/链接危险命令的元字符:重定向 > < >>、命令替换 $() ` `、后台/链式 & &&、换行
  if (/[;&<>\n`]/.test(s)) return false;
  if (/\$\(/.test(s)) return false;
  if (/\|\|/.test(s)) return false; // 只允许管道 |,不允许逻辑或 ||
  const segs = s.split("|").map((x) => x.trim()).filter(Boolean);
  if (!segs.length) return false;
  for (const seg of segs) {
    const toks = seg.split(/\s+/);
    const cmd = (toks[0] ?? "").replace(/^.*\//, ""); // 去路径前缀:/bin/ls → ls
    if (cmd === "git") {
      if (!toks[1] || !SAFE_GIT_SUB.has(toks[1])) return false;
      continue;
    }
    if (cmd === "find") {
      // find 默认只查;但 -delete/-exec/-fprint 等会改文件或执行命令 → 不放行。
      if (/(^|\s)-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/.test(seg)) return false;
      continue;
    }
    if (!SAFE_READONLY_CMDS.has(cmd)) return false;
  }
  return true;
}
