// 包管理器命令的粗粒度识别,exec_shell.ts(前台 abort 路径)和 process_manager.ts(后台
// KillShell 路径)共用同一份正则,避免两处各自维护、后续改一处漏改另一处。
// 命令名前后是空白/分隔符/行首,不匹配文件名里带这几个词的情况(跟 permissions/bash_safety.ts
// 里 cmdRe() 的边界判断同一个思路,避免 \b 的同形字/文件名假阳性)。
export const PKG_MGR_TIMEOUT_RE = /(?:^|[\s;&|])(apt-get|apt|dpkg|aptitude)(?=\s|$|;|&|\|)/;
