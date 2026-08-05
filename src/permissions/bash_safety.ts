import { splitBashCommands } from "./rules.js";

// S2.1 危险命令黑名单:识别"不可逆破坏 / 远程代码执行 / 提权"类 shell 命令。
// 命中者即便在 auto/yolo 下也强制人工确认(见 engine.mustConfirm + gate auto 路径)。
// 启发式(非完备),宁可多问一次:复合命令逐段判定,任一段命中即返回原因。
// 命令词边界:关键词后面必须紧跟空白/命令分隔符/结尾才算"在调用这个命令"。
// 用 \b 做词边界曾经是全文件的通用写法,但 `.`/`-`/`_` 这类字符也算词边界——纯粹是
// 文件名前缀的 "eval.scm"(`python3 interp.py eval.scm`)会被误判成 eval 动态执行,
// 无 TTY 场景下 ask 判定自动转 deny,连续拦掉模型对自己解题文件的正常执行,逼得模型
// 放弃真实运行、改成纯人工代码走查,漏掉了跑测试才能发现的 bug(schemelike-metacircular-eval
// 真实撞见的案例:9 次 Bash 被拒,最终因为没跑通官方测试集漏了 boolean? 原语;
// tune-mjcf 的 eval.py 也是同一个根因)。这不是 eval/sudo 两处的个例,是"用 \b 判断命令名"
// 这整类写法的通病——全文件所有命令名边界检查统一换成这个 helper,不只补两个洞。
const CMD_END = "(?=\\s|$|;|&|\\|)";
function cmdRe(name: string): RegExp {
  return new RegExp(`(^|\\s)${name}${CMD_END}`, "i");
}

// 把 `cd <dir>` 的目录参数遮蔽成占位符,避免目录名撞上危险命令词被判成"调用该命令"。
// 真实撞见:`cd eval && source venv/bin/activate` 里 eval 是目录名,cmdRe("eval") 却把它
// 当成 eval 动态执行,审批误弹"极端危险"。cd 的目标永远只是路径,不可能是被执行的命令。
const CD_ARG = /(^|\s)cd\s+([^\s;&|]+)/gi;
function maskCdArgs(s: string): string {
  return s.replace(CD_ARG, (m, pre: string) => `${pre}cd __DIR__`);
}

// 丢弃到 /dev/null 的重定向(>/dev/null、2>/dev/null、&>/dev/null、>>/dev/null)和纯 fd 复制
// (2>&1、>&2)本身不落盘、不影响任何真实文件,不该被当成"写危险目标"。isReadOnlyShellCommand
// 早就用同一份逻辑摘掉过这类重定向,但 dangerSegment 的"重定向截断系统/家目录文件"规则
// (下面 /dev/ 那条)一直是各判各的、没有摘——裸 `>/dev/null` 命令词边界前手动确认过是最常见
// 的 shell 消音写法(比如 `pdflatex file.tex >/dev/null 2>&1`),真实评测里反复被这条规则
// 误伤(cobol-modernization/dna-assembly/dna-insert/overfull-hbox 四道题独立撞见,overfull-hbox
// 那次模型完全没能猜中真实原因,来回试错好几轮才误打误撞绕开)。两处判断共用同一个正则,
// 避免再次出现"一处摘了一处没摘"的不一致。
const DEV_NULL_REDIRECT = /\s*&?\d*>>?\s*(\/dev\/null\b|&\d+\b)/g;
function stripDevNullRedirects(s: string): string {
  return s.replace(DEV_NULL_REDIRECT, "");
}

function dangerSegment(seg: string): string | null {
  // 先遮蔽 `cd <dir>` 的目录参数:目录名撞上危险命令词(eval/sudo/rm 等)只是路径,不是调用该命令。
  // 真实撞见:`cd eval && ...` 把 eval 目录误判成 eval 动态执行,审批误弹"极端危险"。
  const s = maskCdArgs(seg);
  // rm 递归 + 危险目标(根/家目录/通配)——相对路径如 node_modules 不触发
  if (cmdRe("rm").test(s) && /(^|\s)-\S*r/i.test(s)) {
    if (/\s(\/|~|\$home)(\s|\/|$)/i.test(s) || /\s\/\*(\s|$)/.test(s) || /(^|\s)\*(\s|$)/.test(s) || /\s~\//i.test(s)) return "rm 递归删除根/家目录/通配,可能毁坏系统";
  }
  // 写裸磁盘设备 / 格式化(含 dd of=/dev/disk)
  if (/\b(dd|tee)\b[^|]*of=\s*\/dev\/(sd|nvme|disk|hd)/i.test(s) || />\s*\/dev\/(sd|nvme|disk|hd)/i.test(s)) return "写入裸磁盘设备";
  // mkfs 本身之前是裸检查(无任何复合条件),风险最高——文件名叫 mkfs.conf 光是 cat 一下就会误判。
  // 可选后缀之前是 (\.\w+)? 任意扩展名,连边界写法都救不了(mkfs.conf 从正则角度跟真实的
  // mkfs.ext4 没法区分),收窄成真实存在的文件系统类型后缀,不再匹配任意 .xxx。
  if (cmdRe("mkfs(\\.(ext[234]|xfs|btrfs|fat|vfat|ntfs|reiserfs|jfs|f2fs|minix|swap))?").test(s)) return "格式化文件系统";
  // 递归改权限/属主到危险目标
  if (/\bchmod\s+-?R?\s*0?777\b/i.test(s) || (cmdRe("chmod").test(s) && /(^|\s)-\S*R/.test(s) && /\s(\/|~)(\s|\/|$)/i.test(s))) return "递归/全开 chmod,可能破坏权限";
  // chmod 000:清空权限会让文件/目录不可访问
  if (/\bchmod\s+(-\S+\s+)*0{3,4}\b/i.test(s)) return "chmod 000 清空权限,文件将不可访问";
  if (cmdRe("chown").test(s) && /(^|\s)-\S*R/.test(s) && /\s(\/|~)(\s|\/|$)/i.test(s)) return "递归 chown 到根/家目录";
  // 递归改属组到根/家目录
  if (cmdRe("chgrp").test(s) && /(^|\s)-\S*R/.test(s) && /\s(\/|~)(\s|\/|$)/i.test(s)) return "递归 chgrp 到根/家目录";
  // 覆盖系统配置
  if (/>\s*\/etc\//i.test(s)) return "覆盖 /etc 系统配置";
  // :> /important 截断(把现有文件清空)——危险目标:根/家目录/etc/dev。先摘掉 /dev/null 类
  // 消音重定向再判——它们不写真实文件,不该被这条"写系统目录"规则命中。
  if (/(^|\s):?\s*>\s*(\/(etc|dev|bin|usr|boot|lib|sbin|var)\/|~\/|\$home)/i.test(stripDevNullRedirects(s))) return "重定向截断系统/家目录文件";
  // truncate 危险目标(不可逆清空)——但 /tmp、/var/tmp 是一次性草稿区,截断/模拟损坏自己刚
  // 创建的临时文件不构成真实数据损失(真实撞见:reshard-c4-data 模型 truncate 自己的
  // /tmp/corr/part-000000 模拟"损坏 bundle"这个防御性测试场景,被误判成危险操作静默拒绝)。
  // 只排除 /tmp、/var/tmp 这两个公认的一次性目录,其它绝对路径目标(含相对更深的 /private/tmp
  // 这类系统专属临时区、更别说 /etc 这类真实系统目录)仍然拦。
  {
    const truncateTarget = /\s((?:\/|~)\S*)/i.exec(s)?.[1];
    if (cmdRe("truncate").test(s) && truncateTarget && !/^\/(?:var\/)?tmp\//i.test(truncateTarget)) {
      return "truncate 截断文件(可能清空数据)";
    }
  }
  // shred 本身之前也是裸检查(无任何复合条件),风险最高——文件名叫 shred.py 光是 cat 一下就会误判
  if (cmdRe("shred").test(s)) return "shred 不可逆抹除文件";
  // find ... -delete / -exec rm:批量删除,易因路径/通配失误酿灾
  if (cmdRe("find").test(s) && (/(^|\s)-delete\b/i.test(s) || /(^|\s)-exec\s+(sudo\s+)?rm\b/i.test(s))) return "find 批量删除(-delete/-exec rm)";
  // git 毁历史 / 丢改动
  if (cmdRe("git").test(s) && /\bpush\b/i.test(s) && /(--force(-with-lease)?|(^|\s)-f)\b/i.test(s)) return "git push 强推,可能覆盖远程历史";
  if (cmdRe("git").test(s) && /\breset\b/i.test(s) && /--hard\b/i.test(s)) return "git reset --hard,丢弃未提交改动";
  if (cmdRe("git").test(s) && /\bclean\b/i.test(s) && /(^|\s)-\S*f/i.test(s) && /(^|\s)-\S*[dx]/i.test(s)) return "git clean -fdx,删除未跟踪文件";
  // 批量杀进程:kill 后面紧跟 -9 -1 / -1(不是"kill 和这些 flag 分别出现在字符串某处"这么松,
  // 保持跟原来一样的"紧跟"语义,只是换成不怕文件名前缀撞上的边界写法)
  if (new RegExp(`(^|\\s)kill${CMD_END}\\s+-9\\s+-1\\b`, "i").test(s) || new RegExp(`(^|\\s)kill${CMD_END}\\s+-1\\b`, "i").test(s)) return "kill -1/-9 -1,杀光本用户所有进程";
  // killall 本身之前也是裸检查,风险最高——文件名叫 killall.sh 光是 cat 一下就会误判
  if (cmdRe("killall").test(s)) return "killall 批量杀进程";
  if (cmdRe("pkill").test(s) && /(^|\s)-9\b/i.test(s)) return "pkill -9 强杀进程";
  // 提权 / 动态执行
  if (cmdRe("sudo").test(s)) return "sudo 提权";
  if (cmdRe("eval").test(s)) return "eval 动态执行";
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
  "cd", // 只改 shell 进程内部工作目录,无文件系统副作用
]);
// git 只读子命令(push/reset/clean/stash 等改动类不在内)。
const SAFE_GIT_SUB = new Set([
  "status", "log", "diff", "show", "branch", "remote", "tag", "describe", "rev-parse",
  "ls-files", "ls-tree", "blame", "shortlog", "reflog", "whatchanged", "cat-file",
  "for-each-ref", "name-rev", "symbolic-ref", "rev-list", "Config",
]);

// 判定一条 shell 命令是否【纯只读、可在 auto 模式快速放行】——保守优先,拿不准就返回 false(交分类器/人工)。
// 放行:管道 | 和顺序链接 ; \n && 把多条只读命令串起来(每段首词都是只读程序即可,比如
// "cat /etc/x.service; ls /lib/y*" 这种探查式复合命令——mailman 那次撞见的真实卡死场景就是
// 这种由分号链起来的三条纯读命令,之前 ; 直接被当危险字符整条拒绝,根本没走到"分段判断只读"这步,
// 这次一起补上)。同一场景里三段命令还各自带了 2>/dev/null(消音 stderr,不写入任何有意义的
// 地方)——这类"丢弃到 /dev/null"的重定向单独摘出来放行,其余重定向 > < >>(会写真实文件)、
// 命令替换 $() ` `(可执行任意子命令)仍然拒绝。后台 &(不参与逻辑判断,单独出现即拒)、
// 逻辑或 ||(可能藏"失败就干别的"这类分支,保持保守)。
// 不替代敏感目标判定(cat ~/.ssh/id_rsa 由 mustConfirm 拦,调用方应先查 mustConfirm)。
export function isReadOnlyShellCommand(command: string): boolean {
  if (typeof command !== "string") return false;
  const s = command.trim();
  if (!s) return false;
  if (isDangerousCommand(s)) return false; // 双保险
  // 丢弃到 /dev/null 的重定向(2>/dev/null、>/dev/null、&>/dev/null、>>/dev/null)和纯 fd 复制
  // (2>&1、>&2,只是让 stderr/stdout 互相指向,不落盘)先摘掉再判——都不算"会写文件"。
  // 复用 dangerSegment 那边同一份正则(DEV_NULL_REDIRECT),避免两处再次各判各的。
  const sansDevNull = stripDevNullRedirects(s);
  if (/<|>|`/.test(sansDevNull)) return false; // 重定向/命令替换(反引号形式)
  if (/\$\(/.test(s)) return false; // 命令替换 $(...)
  if (/\|\|/.test(s)) return false; // 逻辑或,保持保守
  // 裸 & (后台/并发)要拒,但不能被 && 或已摘掉的 fd 复制(2>&1 里的 &)误伤:
  // 用 sansDevNull(已经去掉 2>&1 这类)挖掉所有 &&,剩下还有 & 才是真背景执行。
  if (/&/.test(sansDevNull.replace(/&&/g, ""))) return false;
  const segs = s.split(/;|\n|&&|\|/).map((x) => x.trim()).filter(Boolean);
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
