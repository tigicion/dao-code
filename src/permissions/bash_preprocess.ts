// Bash 命令预处理(参考 stripSafeWrappers / stripAllLeadingEnvVars / extractOutputRedirections)。
// 在权限规则匹配前对命令做归一化:剥离安全包装器、环境变量前缀、输出重定向,
// 使规则能匹配到实际执行的命令,防止通过包装器/env 前缀绕过 deny/ask 规则。

// 安全环境变量白名单:这些变量不能执行代码或加载库,可以安全剥离。
// SECURITY: PATH / LD_* / DYLD_* / PYTHONPATH / NODE_OPTIONS 等永远不能加入——它们可以改变执行的二进制。
const SAFE_ENV_VARS = new Set([
  "NODE_ENV",
  "RUST_BACKTRACE", "RUST_LOG",
  "PYTHONUNBUFFERED", "PYTHONDONTWRITEBYTECODE",
  "GOOS", "GOARCH", "CGO_ENABLED", "GO111MODULE", "GOEXPERIMENT",
  "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "NO_COLOR", "FORCE_COLOR",
  "CI",
])

// 安全环境变量赋值:VAR=value 后跟横向空白。值只允许安全字符(不含 $() ` ; | & 等注入字符)。
// SECURITY: 尾部空白必须用 [ \t]+(横向),不能用 \s+——\s 匹配 \n/\r,跨行剥离会把下一行命令暴露出来。
const ENV_VAR_SAFE_RE = /^([A-Za-z_]\w*)=([A-Za-z0-9_./:-]+)[ \t]+/

// 所有环境变量赋值(更宽松,deny/ask 用):支持引号值。
// 值模式排除 shell 元字符($ ` ; | & ( ) < > \ 换行)以防注入。
const ENV_VAR_ALL_RE = /^([A-Za-z_]\w*)=(?:'[^']*'|"[^"]*"|[^ \t\n\r$`;|&()<>\\]+)[ \t]+/

// 剥离整行注释(# 开头的行)。保留非注释行;全是注释时返回原命令(不让空命令误匹配)。
function stripCommentLines(command: string): string {
  const lines = command.split("\n")
  const kept = lines.filter(l => {
    const t = l.trim()
    return t !== "" && !t.startsWith("#")
  })
  return kept.length === 0 ? command : kept.join("\n")
}

// 解析 timeout 命令并返回剥离后的实际命令。timeout 需要特殊处理(跳过 flag + 时长)。
// 返回 null 表示不是 timeout 命令;返回空串表示 timeout 后没有实际命令。
function stripTimeout(command: string): string | null {
  if (!/^timeout[ \t]/.test(command)) return null
  const toks = command.trim().split(/\s+/)
  let i = 1
  while (i < toks.length && toks[i]!.startsWith("-")) {
    if (toks[i] === "--") { i++; break }
    // -k VAL / -s VAL:跳过 flag + 下一个 token(如果它不是 - 开头且像值)
    if ((toks[i] === "-k" || toks[i] === "-s") && i + 1 < toks.length && !toks[i + 1]!.startsWith("-")) {
      i += 2
    } else {
      i++
    }
  }
  // 跳过时长(数字 + 可选单位)
  if (i < toks.length && /^\d+(?:\.\d+)?[smhd]?$/.test(toks[i]!)) i++
  // 可选的 -- 分隔符
  if (i < toks.length && toks[i] === "--") i++
  return toks.slice(i).join(" ")
}

// 安全包装器正则:time / nohup / nice / stdbuf 用 execvp 运行参数,剥离后暴露实际命令。
// timeout 用 stripTimeout 特殊处理(需解析 flag 找时长)。
// SECURITY: 用 [ \t]+ 而非 \s+,防止跨行匹配把下一行命令剥离进来。
const SAFE_WRAPPER_PATTERNS = [
  /^time(?:[ \t]+--)?[ \t]+/,
  /^nohup(?:[ \t]+--)?[ \t]+/,
  // nice [-n N | -N] cmd
  /^nice(?:[ \t]+-n[ \t]+-?\d+|[ \t]+-\d+)?(?:[ \t]+--)?[ \t]+/,
  // stdbuf -iL -o0 -eN cmd
  /^stdbuf(?:[ \t]+-[ioe][LN0-9]+)+(?:[ \t]+--)?[ \t]+/,
]

// 剥离安全包装器(timeout/time/nice/nohup/stdbuf)和安全环境变量前缀。
// 用于 allow 规则:只剥离安全环境变量,防止 DOCKER_HOST=evil docker ps 匹配 Bash(docker ps:*)。
export function stripSafeWrappers(command: string): string {
  let stripped = command
  let prev = ""
  // Phase 1: 剥离注释和安全环境变量
  while (stripped !== prev) {
    prev = stripped
    stripped = stripCommentLines(stripped)
    const m = stripped.match(ENV_VAR_SAFE_RE)
    if (m && SAFE_ENV_VARS.has(m[1]!)) {
      stripped = stripped.replace(ENV_VAR_SAFE_RE, "")
    }
  }
  // Phase 2: 剥离注释和安全包装器(不再剥离环境变量——包装器后的 VAR=val 是命令不是赋值)
  prev = ""
  while (stripped !== prev) {
    prev = stripped
    stripped = stripCommentLines(stripped)
    const to = stripTimeout(stripped)
    if (to !== null) { stripped = to; continue }
    for (const p of SAFE_WRAPPER_PATTERNS) {
      stripped = stripped.replace(p, "")
    }
  }
  return stripped.trim()
}

// 剥离所有前导环境变量(不限于安全列表)。
// 用于 deny/ask 规则:更激进,防止 FOO=bar denied_command 绕过 deny 规则。
export function stripAllLeadingEnvVars(command: string): string {
  let stripped = command
  let prev = ""
  while (stripped !== prev) {
    prev = stripped
    stripped = stripCommentLines(stripped)
    const m = stripped.match(ENV_VAR_ALL_RE)
    if (m) stripped = stripped.slice(m[0].length)
  }
  return stripped.trim()
}

// 剥离输出重定向(>file, >>file, 2>file, 2>&1, &>file, >/dev/null 等)。
// 使规则匹配到实际命令而非重定向目标——python script.py > /etc/passwd 应匹配 Bash(python:*),
// 而非被 > /etc/passwd 干扰。不处理 heredoc(<<)和进程替换 <(cmd)。
export function extractOutputRedirections(command: string): string {
  return command
    .replace(/\s+\d*>{1,2}\s*(?:&\d+|[^\s|;&<>"'])+/g, "")
    .replace(/\s+&>{1,2}\s*[^\s|;&<>"']+/g, "")
    .trim()
}

// 判断是否复合命令(含 && || ; | 或换行)。
// 前缀/通配符规则不应匹配复合命令——防 cd /x && rm -rf / 整串匹配 Bash(cd:*)。
export function isCompoundCommand(command: string): boolean {
  return /\s*(?:&&|\|\||[;\n|])\s*/.test(command)
}
