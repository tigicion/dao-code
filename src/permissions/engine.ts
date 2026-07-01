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

// 安全敏感目标:SSH 私钥/凭据、shell 启动脚本、.git 内部、/etc、dao/claude 自身状态等。
const SENSITIVE_TARGET =
  /\.ssh\/|id_rsa|id_ed25519|id_ecdsa|authorized_keys|\.aws\/|\.npmrc|\.netrc|credentials|\.gitconfig|\.git\/|\.bashrc|\.zshrc|\.bash_profile|\.zprofile|\/etc\/|\.dao\/config\.json/;

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
  const sensitiveTarget = (p.capability === "write" || p.capability === "exec") && !!id?.value && SENSITIVE_TARGET.test(id.value);
  return sensitiveTarget || isDangerousCall(p.toolName, p.argsJson);
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
