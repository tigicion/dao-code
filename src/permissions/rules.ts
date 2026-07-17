// Claude Code 权限规则引擎(1:1 复刻):规则语法 Tool(specifier) + deny>ask>allow 优先级。
// specifier 语义随工具:Bash=命令前缀/精确,Read/Edit/Write/LS/Glob/Grep=gitignore-glob 路径,
// WebFetch=domain:<host>,其余=精确/glob。

import {
  stripSafeWrappers,
  stripAllLeadingEnvVars,
  extractOutputRedirections,
  isCompoundCommand,
} from "./bash_preprocess.js";

export type Decision = "allow" | "ask" | "deny";

export interface ParsedRule {
  tool: string;
  specifier?: string;
}

// 一次工具调用映射到的 CC 工具身份:ccTool=CC 工具名,value=用于匹配 specifier 的值
// (Bash=命令,Read/Edit/…=路径,WebFetch=URL)。
export interface CallIdentity {
  ccTool: string;
  value: string;
}

export interface RuleSets {
  allow: string[];
  ask: string[];
  deny: string[];
}

// 解析 "Tool" 或 "Tool(specifier)"。specifier 内可含括号/斜杠(取首个 '(' 到末个 ')')。
export function parseRule(s: string): ParsedRule {
  const str = s.trim();
  const open = str.indexOf("(");
  if (open === -1 || !str.endsWith(")")) return { tool: str };
  return { tool: str.slice(0, open), specifier: str.slice(open + 1, -1) };
}

// 路径型工具:specifier 按 gitignore 风格 glob 匹配路径。
const PATH_TOOLS = new Set(["Read", "Edit", "Write", "LS", "Glob", "Grep"]);

// glob → 正则:** 跨段,* 单段(不跨 /),? 单字符。其余字符转义。
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; } // **
      else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

function matchPath(specifier: string, value: string): boolean {
  // 绝对 glob 以 // 开头(CC 约定):规整成单斜杠再比。
  const pat = specifier.startsWith("//") ? specifier.slice(1) : specifier;
  const re = globToRegExp(pat);
  if (re.test(value)) return true;
  // 无斜杠的模式(如 *.env)按 gitignore 语义匹配任意目录下的同名文件(比 basename)。
  if (!pat.includes("/")) {
    const base = value.split("/").pop() ?? value;
    return re.test(base);
  }
  return false;
}

// 检查命令是否以指定前缀开头(词边界:前缀后必须是空白或命令结尾)。
// 防止 Bash(ls:*) 匹配 "lsof" 或 "lsattr"——前缀后必须跟空格或到串尾。
function startsWithWordBoundary(prefix: string, cmd: string): boolean {
  if (cmd === prefix) return true;
  if (cmd.startsWith(prefix + " ")) return true;
  // xargs 透传:裸 xargs(无 flag)后跟的命令也检查——Bash(grep:*) 应匹配 "xargs grep pattern"。
  const xargsPrefix = "xargs " + prefix;
  if (cmd === xargsPrefix) return true;
  if (cmd.startsWith(xargsPrefix + " ")) return true;
  return false;
}

function matchBash(specifier: string, command: string): boolean {
  const cmd = command.trim();
  if (specifier === "*") return true;
  if (specifier.endsWith(":*")) return startsWithWordBoundary(specifier.slice(0, -2), cmd);
  if (specifier.includes("*")) return globToRegExp(specifier).test(cmd);
  return cmd === specifier.trim();
}

function matchDomain(specifier: string, url: string): boolean {
  const want = specifier.startsWith("domain:") ? specifier.slice(7) : specifier;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    host = url; // 不是完整 URL 时按裸 host 比
  }
  return host === want || host.endsWith("." + want);
}

// 单条规则是否命中某次调用。
export function ruleMatches(rule: ParsedRule, id: CallIdentity): boolean {
  if (rule.tool !== id.ccTool) return false;
  if (rule.specifier === undefined) return true; // 裸工具名匹配该工具全部调用
  if (rule.tool === "Bash") return matchBash(rule.specifier, id.value);
  if (rule.tool === "WebFetch") return matchDomain(rule.specifier, id.value);
  if (PATH_TOOLS.has(rule.tool)) return matchPath(rule.specifier, id.value);
  // 其它工具:支持 glob,否则精确。
  return rule.specifier.includes("*")
    ? globToRegExp(rule.specifier).test(id.value)
    : id.value === rule.specifier;
}

// 复合命令拆分(CC 行为):按 && || ; | 换行 拆成子命令,逐段做权限检查。
// 否则 `cd /tmp && rm -rf x` 整串不会命中 `Bash(rm -rf:*)` 的 deny,形成绕过。
export function splitBashCommands(cmd: string): string[] {
  return cmd
    .split(/\s*(?:&&|\|\||[;\n|])\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 为 Bash 命令生成匹配候选列表——对原始命令做各种预处理剥离,收集所有可能的匹配形式。
// 对标 CC filterRulesByContentsMatchingInput 的候选生成策略:
//   - 原始命令(保留引号用于精确匹配)
//   - 去输出重定向后的命令(使 Bash(python:*))匹配 "python script.py > output.txt")
//   - 对每个候选再剥离安全包装器(使 Bash(npm install:*))匹配 "timeout 10 npm install foo")
//
// deny/ask 规则还需额外尝试剥离所有环境变量前缀(更激进,防 FOO=bar rm 绕过)。
// allow 规则只剥离安全环境变量(防 DOCKER_HOST=evil docker ps 匹配)。
function bashCandidates(command: string, stripAllEnv: boolean): string[] {
  const cmd = command.trim()
  // 去重定向 + 不去重定向两种形式
  const cmdNoRedirect = extractOutputRedirections(cmd)
  const base = cmdNoRedirect !== cmd ? [cmd, cmdNoRedirect] : [cmd]

  const candidates: string[] = []
  const seen = new Set<string>()

  const add = (c: string) => {
    const t = c.trim()
    if (t && !seen.has(t)) { seen.add(t); candidates.push(t) }
  }

  for (const c of base) {
    add(c)
    // 剥离安全包装器(allow 规则路径)
    add(stripSafeWrappers(c))
    // deny/ask 规则:还要尝试剥离所有环境变量
    if (stripAllEnv) {
      // 迭代到不动点:交替剥离 env vars 和 safe wrappers,处理 nohup FOO=bar timeout 5 cmd 这种交错
      let current = c
      let prev = ""
      while (current !== prev) {
        prev = current
        current = stripAllLeadingEnvVars(current)
        current = stripSafeWrappers(current)
      }
      add(current)
    }
  }
  return candidates
}

// 检查一组 Bash 规则是否匹配命令(考虑预处理剥离)。
// 对标 CC filterRulesByContentsMatchingInput。
function bashRulesMatch(
  rules: string[],
  command: string,
  opts: { stripAllEnv?: boolean; checkCompound?: boolean } = {},
): boolean {
  const { stripAllEnv = false, checkCompound = true } = opts
  const parsed = rules.map(parseRule)
  // 前缀/通配符规则不应匹配复合命令——防 cd /x && rm -rf / 整串匹配 Bash(cd:*)。
  // 但精确匹配可以匹配整条复合命令(用户可能写了精确的复合命令规则)。
  const compound = checkCompound && isCompoundCommand(command)

  for (const rule of parsed) {
    if (rule.tool !== "Bash") continue
    if (rule.specifier === undefined) return true // 裸 "Bash" 匹配所有
    const candidates = bashCandidates(command, stripAllEnv)
    for (const cand of candidates) {
      if (compound) {
        // 复合命令:只允许精确匹配(非前缀/非通配符)
        const spec = rule.specifier
        if (spec === "*") continue // 通配符不匹配复合命令
        if (spec.endsWith(":*")) continue // 前缀不匹配复合命令
        if (spec.includes("*")) continue // glob 不匹配复合命令
        if (cand === spec.trim()) return true
      } else {
        if (matchBash(rule.specifier, cand)) return true
      }
    }
  }
  return false
}

// 优先级:deny > ask > allow > 未匹配(返回 null,交由模式/能力默认决定)。
// Bash:逐子命令检查——任一 deny→deny;否则任一 ask→ask;否则有未覆盖段→null;全 allow→allow。
export function evaluate(rules: RuleSets, id: CallIdentity): Decision | null {
  if (id.ccTool === "Bash") {
    const parts = splitBashCommands(id.value)
    // deny:逐子命令检查,每个子命令用更激进的剥离(stripAllEnv=true)
    if (parts.some(p => bashRulesMatch(rules.deny, p, { stripAllEnv: true, checkCompound: false }))) {
      return "deny"
    }
    let sawAsk = false
    let sawUnmatched = false
    for (const p of parts) {
      if (bashRulesMatch(rules.ask, p, { stripAllEnv: true, checkCompound: false })) {
        sawAsk = true
      } else if (!bashRulesMatch(rules.allow, p, { stripAllEnv: false, checkCompound: false })) {
        sawUnmatched = true
      }
    }
    if (sawAsk) return "ask"
    if (sawUnmatched) return null
    return "allow"
  }
  // 非 Bash 工具:原逻辑
  const hit = (list: string[]) => list.some((r) => ruleMatches(parseRule(r), id));
  if (hit(rules.deny)) return "deny";
  if (hit(rules.ask)) return "ask";
  if (hit(rules.allow)) return "allow";
  return null;
}
