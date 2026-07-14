import type { Capability } from "../tools/types.js";
import { evaluate, type Decision, parseRule, ruleMatches } from "./rules.js";
import { toCcIdentity } from "./identity.js";
import { isDangerousCommand, isReadOnlyShellCommand } from "./bash_safety.js";
import type { PermissionsConfig, PermissionMode } from "./settings.js";

export interface DecideParams {
  toolName: string;
  argsJson: string;
  capability: Capability;
  mode: PermissionMode;
  rules: PermissionsConfig;
}

// 读也会泄漏的目标:凭据/密钥material。不分 capability、不分读写——read_file 读一遍 id_rsa
// 跟 exec_shell 里 cat 一遍,结果都是私钥内容进了模型上下文,没道理只挡后者。
const SECRET_TARGET =
  /\.ssh\/|id_rsa|id_ed25519|id_ecdsa|authorized_keys|\.aws\/|\.npmrc|\.netrc|credentials|\.dao\/config\.json|\/etc\/(shadow|gshadow|ssl\/private|ssh\/ssh_host_\w+_key)\b/;

// 只有写/改动才危险、纯读安全的目标:/etc 配置(除上面已经算 SECRET_TARGET 的那几个子路径)、
// shell 启动脚本、.git 内部/.gitconfig。这类文件本身不是秘密,危险的是被改写(比如往 .bashrc
// 里种持久化后门、往 /etc/postfix 写坏配置),看一眼不会泄漏什么也不会改变系统状态。
const WRITE_ONLY_SENSITIVE_TARGET =
  /\.gitconfig|\.git\/|\.bashrc|\.zshrc|\.bash_profile|\.zprofile|\/etc\//;

// 沿用旧的合并集合,给"审批时不提供始终允许"这个更宽松的用途用(不需要精确区分读写,
// 保守一点没坏处——避免把敏感目标的访问权限永久固化下来)。
const SENSITIVE_TARGET = new RegExp(`${SECRET_TARGET.source}|${WRITE_ONLY_SENSITIVE_TARGET.source}`);

// 该调用是否触及安全敏感目标(写/执行)。审批时据此【不提供"始终允许"】——避免永久放行危险操作。
export function isSensitiveCall(toolName: string, argsJson: string): boolean {
  const id = toCcIdentity(toolName, argsJson);
  return !!id?.value && SENSITIVE_TARGET.test(id.value);
}

// 从 exec_shell 的 argsJson 取出 command 字符串(解析失败→空串,快速路径据此不放行)。
function extractCommand(argsJson: string): string {
  try { return (JSON.parse(argsJson) as { command?: string })?.command ?? ""; }
  catch { return ""; }
}

// S2.1 危险 shell 命令(rm -rf /、curl|sh、提权…):exec_shell 专属判定。
export function isDangerousCall(toolName: string, argsJson: string): boolean {
  if (toolName !== "exec_shell") return false;
  try { return isDangerousCommand((JSON.parse(argsJson) as { command?: string })?.command ?? "") != null; }
  catch { return false; }
}

// S3.1 must-confirm:触及敏感目标的写/执行,或危险 shell 命令。任何模式(含 yolo)都强制人工确认,
// 除非有显式 allow 规则 opt-in。配合 gate auto 路径:此类调用跳过分类器、直接走人工。
function mustConfirm(p: DecideParams): boolean {
  const id = toCcIdentity(p.toolName, p.argsJson);
  if (!id?.value) return isDangerousCall(p.toolName, p.argsJson);
  // 凭据/密钥类:读也泄漏,不管 capability、不管是不是纯读命令,一律强制确认。
  if (SECRET_TARGET.test(id.value)) return true;
  // 只写才危险的目标(/etc、.git、shell 启动脚本):capability 得是 write/exec 才可能构成风险;
  // 如果是 exec_shell 且整条命令能确认是纯只读(cat/ls/grep 这类,isReadOnlyShellCommand 已经
  // 排除了重定向/命令替换/危险命令等),读一眼不算风险,放行——之前不分读写一律拦,是
  // sysadmin 类任务(改 /etc/postfix、/etc/mailman3 这种)反复被同一条规则拦、且往往拦的是
  // 无害的 cat/ls 探查步骤,才发现这个粒度太粗。
  if ((p.capability === "write" || p.capability === "exec") && WRITE_ONLY_SENSITIVE_TARGET.test(id.value)) {
    const isReadOnlyExec = p.toolName === "exec_shell" && isReadOnlyShellCommand(extractCommand(p.argsJson));
    if (!isReadOnlyExec) return true;
  }
  return isDangerousCall(p.toolName, p.argsJson);
}

// auto 模式安全白名单(对标 CC SAFE_YOLO_ALLOWLISTED_TOOLS):只读/搜索/任务管理/计划类工具
// 即便被升级到"需确认"也直接放行,省一次分类器调用。exec_shell/外部写不在内,必须过分类器。
// 网络查询(web_search/fetch_url)auto 下放行:属"读取型"取信息,deny 规则仍能覆盖;fetch_url 自带 SSRF 挡内网/元数据。
const AUTO_ALLOWLIST = new Set([
  "read_file", "grep_files", "file_search", "list_dir",
  "todo_write", "ask_user", "memory_read", "skill", "verify_done", "echo",
  "web_search", "fetch_url",
]);

// 单次工具调用的权限裁决,1:1 复刻 CC 优先级:
//   deny 规则 > bypassPermissions(yolo:deny 之外全过)> 安全敏感目标确认 > ask 规则 > allow 规则 > 模式/能力默认。
// deny 是硬黑名单,任何模式(含 bypass)都拦截。
export function decide(p: DecideParams): Decision {
  const d = decideBase(p);
  // auto 模式:把"需确认"的调用尽量在 AI 分类器之前快速放行(对标 CC 快速路径②③)。
  if (d === "ask" && p.mode === "auto") {
    if (AUTO_ALLOWLIST.has(p.toolName)) return "allow"; // ③ 安全白名单(只读类工具)
    // ③' 只读 shell 命令(ls/cat/git status…)快速放行:免一次分类器、也不被拒绝熔断牵连。
    // 触及敏感目标(已在上面 mustConfirm→ask)或危险命令的不会走到这(isReadOnlyShellCommand 内部再次双保险)。
    if (p.toolName === "exec_shell" && !mustConfirm(p) && isReadOnlyShellCommand(extractCommand(p.argsJson))) return "allow";
    if (decideBase({ ...p, mode: "acceptEdits" }) === "allow") return "allow"; // ② acceptEdits 会放行(工作区内编辑)
    return "ask"; // ④ 交分类器
  }
  return d;
}

// `if` 预过滤:CC 规则式(如 "Bash(git push *)")是否匹配此工具调用。
// 复用 rules.ts 的 parseRule + ruleMatches(同权限引擎路径,语义一致)。
export function matchesIfClause(ifPattern: string, toolName: string, argsJson: string): boolean {
  const id = toCcIdentity(toolName, argsJson);
  if (!id) return false;
  return ruleMatches(parseRule(ifPattern), id);
}

function decideBase(p: DecideParams): Decision {
  const id = toCcIdentity(p.toolName, p.argsJson);
  const ruleDec = id ? evaluate(p.rules, id) : null;

  if (ruleDec === "deny") return "deny";
  // S3.1 敏感目标写/执行 + 危险 shell 命令:除 plan(只读、下方一律 deny 更严)外的任何模式(含 yolo)
  // 都要确认,除非显式 allow 规则 opt-in。放在 bypassPermissions 之前 → yolo 也不能绕过(对标 CC bypass-immune)。
  if (ruleDec !== "allow" && p.mode !== "plan" && mustConfirm(p)) return "ask";
  // bypassPermissions(yolo):deny + must-confirm 之外一律放行(用户已 --yolo 启动,自担其余风险)。
  if (p.mode === "bypassPermissions") return "allow";
  if (ruleDec === "ask") return "ask";
  if (ruleDec === "allow") return "allow";

  // 无规则命中 → 模式 + 能力默认
  const sideEffecting = p.capability === "write" || p.capability === "exec" || p.capability === "network";
  if (p.mode === "plan") return sideEffecting ? "deny" : "allow";
  if (p.mode === "acceptEdits" && id && (id.ccTool === "Edit" || id.ccTool === "Write")) return "allow";
  return sideEffecting ? "ask" : "allow";
}
