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

// S3.1 must-confirm:触及敏感目标的写/执行,或危险 shell 命令。配合 gate auto 路径:
// 此类调用跳过分类器、直接走人工——除非显式 allow 规则 opt-in,或落在下面 yolo 例外里。
function mustConfirm(p: DecideParams): boolean {
  const id = toCcIdentity(p.toolName, p.argsJson);
  if (!id?.value) return isDangerousCall(p.toolName, p.argsJson);
  // 凭据/密钥类:读也泄漏,不管 capability、不管是不是纯读命令、也不管模式(含 yolo)一律
  // 强制确认——这类是真实的数据泄露/凭据失窃风险,yolo 也不该绕过。
  if (SECRET_TARGET.test(id.value)) return true;
  // 只写才危险的目标(/etc、.git、shell 启动脚本):yolo(bypassPermissions)下不再 bypass-immune——
  // 用户已经显式 --yolo 表示要完全自动化,这类目标本身不是秘密(泄不泄漏无所谓),危险的只是
  // "被意外改写"这个动作,而 yolo 的语义就是"我已经决定不要为动作类风险弹确认了"。真实撞见的
  // 案例:sysadmin 类任务(配置 nginx、mailman、postfix 这些)大量需要写 /etc/ 下的文件,
  // headless+yolo 场景下没有人能应答确认,S3.1 的 bypass-immune 设计让这整类任务结构性地
  // 做不完——跟 SECRET_TARGET(真实泄密风险)不是同一个风险等级,不该用同一条免疫规则。
  // 非 yolo 模式(default/acceptEdits/auto)下这类目标依然要确认,行为不变。
  if (p.mode !== "bypassPermissions" && (p.capability === "write" || p.capability === "exec") && WRITE_ONLY_SENSITIVE_TARGET.test(id.value)) {
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
// 同步版本:用 legacy splitBashCommands 拆分 Bash 命令。
export function decide(p: DecideParams): Decision {
  const d = decideBase(p);
  // auto 模式:把"需确认"的调用尽量在 AI 分类器之前快速放行(对标 CC 快速路径②③)。
  if (d === "ask" && p.mode === "auto") {
    if (AUTO_ALLOWLIST.has(p.toolName)) return "allow"; // ③ 安全白名单(只读类工具)
    // ③' 只读 shell 命令的快速放行已经并进 decideBase 本身(不分模式),这里到达时 d 已经不可能
    // 是因为"只读"而 ask——若走到这,要么是显式 ask 规则命中,要么是非只读命令,都不该在这再放行。
    if (decideBase({ ...p, mode: "acceptEdits" }) === "allow") return "allow"; // ② acceptEdits 会放行(工作区内编辑)
    return "ask"; // ④ 交分类器
  }
  return d;
}

// async 版本:Bash 工具用 AST 解析(精确子命令提取 + too-complex fail-closed)。
// 非 Bash 工具走同步 decide。
// 对标 CC bashToolHasPermission:步骤 0(AST parse)→ too-complex fail-closed → 规则匹配。
export async function decideAsync(p: DecideParams): Promise<Decision> {
  if (p.toolName !== "exec_shell") return decide(p);
  const id = toCcIdentity(p.toolName, p.argsJson);
  if (!id) return decide(p);

  // 动态 import:避免非 exec_shell 路径加载 AST 模块(~7000 行)
  const { evaluateWithAst } = await import("./rules.js");
  const ruleDec = await evaluateWithAst(p.rules, id);

  if (ruleDec === "deny") return "deny";
  if (ruleDec !== "allow" && p.mode !== "plan" && mustConfirm(p)) return "ask";
  if (p.mode === "bypassPermissions") return "allow";
  if (ruleDec === "ask") return "ask";
  if (ruleDec === "allow") return "allow";

  // 只读 shell 命令:不分模式一律快速放行(同 decideBase 的逻辑,这里 toolName 恒为 exec_shell,
  // 已在函数顶部 return decide(p) 分流掉了非 exec_shell 的情况)。不含 plan,理由同 decideBase。
  if (p.mode !== "plan" && isReadOnlyShellCommand(extractCommand(p.argsJson))) return "allow";

  // 无规则命中 → 模式 + 能力默认
  const sideEffecting = p.capability === "write" || p.capability === "exec" || p.capability === "network";
  if (p.mode === "plan") return sideEffecting ? "deny" : "allow";
  if (p.mode === "acceptEdits" && id && (id.ccTool === "Edit" || id.ccTool === "Write")) return "allow";

  // auto 模式快速路径(同 decide 中的逻辑)
  if (p.mode === "auto" && sideEffecting) {
    if (AUTO_ALLOWLIST.has(p.toolName)) return "allow";
    if (decideBase({ ...p, mode: "acceptEdits" }) === "allow") return "allow";
    return "ask";
  }

  return sideEffecting ? "ask" : "allow";
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

  // 只读 shell 命令(ls/cat/git status/find 不带 -delete…):不分模式一律快速放行,免一次审批——
  // exec_shell 的 capability 标了 "exec" 不代表这次调用真有副作用,没道理因为工具本身的分类就问。
  // 已过上面的 mustConfirm(SECRET_TARGET/危险命令双保险 fail-closed),这里再判一次纯读安全即可。
  // 不含 plan:plan 模式跳过了 mustConfirm(见上面 `p.mode !== "plan"` 那个条件),SECRET_TARGET
  // 检查没跑过,这里如果也放行会让 `cat ~/.ssh/id_rsa` 绕过凭据保护——保持 plan 原有"exec 一律 deny"。
  if (p.mode !== "plan" && p.toolName === "exec_shell" && isReadOnlyShellCommand(extractCommand(p.argsJson))) return "allow";

  // 无规则命中 → 模式 + 能力默认
  const sideEffecting = p.capability === "write" || p.capability === "exec" || p.capability === "network";
  if (p.mode === "plan") return sideEffecting ? "deny" : "allow";
  if (p.mode === "acceptEdits" && id && (id.ccTool === "Edit" || id.ccTool === "Write")) return "allow";
  return sideEffecting ? "ask" : "allow";
}
