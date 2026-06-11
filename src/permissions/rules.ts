// Claude Code 权限规则引擎(1:1 复刻):规则语法 Tool(specifier) + deny>ask>allow 优先级。
// specifier 语义随工具:Bash=命令前缀/精确,Read/Edit/Write/LS/Glob/Grep=gitignore-glob 路径,
// WebFetch=domain:<host>,其余=精确/glob。

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

function matchBash(specifier: string, command: string): boolean {
  const cmd = command.trim();
  if (specifier === "*") return true;
  if (specifier.endsWith(":*")) return cmd.startsWith(specifier.slice(0, -2));
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

// 优先级:deny > ask > allow > 未匹配(返回 null,交由模式/能力默认决定)。
// Bash:逐子命令检查——任一 deny→deny;否则任一 ask→ask;否则有未覆盖段→null;全 allow→allow。
export function evaluate(rules: RuleSets, id: CallIdentity): Decision | null {
  if (id.ccTool === "Bash") {
    const parts = splitBashCommands(id.value);
    const hitAny = (list: string[], value: string) =>
      list.some((r) => ruleMatches(parseRule(r), { ccTool: "Bash", value }));
    if (parts.some((p) => hitAny(rules.deny, p))) return "deny";
    let sawAsk = false;
    let sawUnmatched = false;
    for (const p of parts) {
      if (hitAny(rules.ask, p)) sawAsk = true;
      else if (!hitAny(rules.allow, p)) sawUnmatched = true;
    }
    if (sawAsk) return "ask";
    if (sawUnmatched) return null;
    return "allow";
  }
  const hit = (list: string[]) => list.some((r) => ruleMatches(parseRule(r), id));
  if (hit(rules.deny)) return "deny";
  if (hit(rules.ask)) return "ask";
  if (hit(rules.allow)) return "allow";
  return null;
}
