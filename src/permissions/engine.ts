import type { Capability } from "../tools/types.js";
import { evaluate, type Decision, parseRule, ruleMatches } from "./rules.js";
import { toCcIdentity } from "./identity.js";
import { isDangerousCommand, isReadOnlyShellCommand } from "./bash_safety.js";
import { isDangerousBashPermission } from "./dangerous_patterns.js";
import type { PermissionsConfig, PermissionMode } from "./settings.js";

export interface DecideParams {
  toolName: string;
  argsJson: string;
  capability: Capability;
  mode: PermissionMode;
  rules: PermissionsConfig;
}

// 读也会泄漏的目标:凭据/密钥material。不分 capability、不分读写——Read 读一遍 id_rsa
// 跟 Bash 里 cat 一遍,结果都是私钥内容进了模型上下文,没道理只挡后者。
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

// 从 Bash 的 argsJson 取出 command 字符串(解析失败→空串,快速路径据此不放行)。
function extractCommand(argsJson: string): string {
  try { return (JSON.parse(argsJson) as { command?: string })?.command ?? ""; }
  catch { return ""; }
}

// S2.1 危险 shell 命令(rm -rf /、curl|sh、提权…):Bash 专属判定。
export function isDangerousCall(toolName: string, argsJson: string): boolean {
  if (toolName !== "Bash") return false;
  try { return isDangerousCommand((JSON.parse(argsJson) as { command?: string })?.command ?? "") != null; }
  catch { return false; }
}

// S3.1 敏感目标(裁决第 4 层,bypass 之后):凭据/密钥类读也泄漏,不管 capability、不管是不是
// 纯读命令一律确认——真实的数据泄露/凭据失窃风险。只写才危险的目标(/etc、.git、shell 启动脚本)
// 本身不是秘密,危险的只是"被意外改写"这个动作:写/执行且非只读命令时确认,纯读放行。
// 在 bypass(第 3 层)之后检查 → yolo 下不拦(用户已显式选择全信任,自担其余风险)。
// 危险 shell 命令不在此列——它在第 2 层(bypass 之前)独立检查,任何模式(含 yolo)都确认。
function isSensitiveTargetCall(p: DecideParams): boolean {
  const id = toCcIdentity(p.toolName, p.argsJson);
  if (!id?.value) return false;
  if (SECRET_TARGET.test(id.value)) return true;
  if ((p.capability === "write" || p.capability === "exec") && WRITE_ONLY_SENSITIVE_TARGET.test(id.value)) {
    const isReadOnlyExec = p.toolName === "Bash" && isReadOnlyShellCommand(extractCommand(p.argsJson));
    return !isReadOnlyExec;
  }
  return false;
}

// auto 模式安全白名单(参考 SAFE_YOLO_ALLOWLISTED_TOOLS):只读/搜索/任务管理/计划类工具
// 即便被升级到"需确认"也直接放行,省一次分类器调用。Bash/外部写不在内,必须过分类器。
// 网络查询(WebSearch/WebFetch)auto 下放行:属"读取型"取信息,deny 规则仍能覆盖;WebFetch 自带 SSRF 挡内网/元数据。
const AUTO_ALLOWLIST = new Set([
  "Read", "Grep", "Glob", "ListDir",
  "TodoWrite", "AskUserQuestion", "MemoryRead", "Skill", "VerifyDone", "echo",
  "WebSearch", "WebFetch",
  "LSP",
  "TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "TaskOutput", "TaskStop",
  "CronList",
]);

// 单次工具调用的权限裁决,优先级:
//   deny 规则 > 危险 shell 命令 > bypassPermissions(yolo)> 敏感目标 > ask 规则 > allow 规则 > 只读 shell > 模式/能力默认。
// deny 是硬黑名单,任何模式(含 yolo)都拦截;危险 shell 命令任何模式(含 yolo)都要确认;
// 敏感目标:default 强制确认,auto 交分类器(AI 判定,不再强制人工),yolo/plan 不拦。
// 同步版本:用 legacy splitBashCommands 拆分 Bash 命令。
export function decide(p: DecideParams): Decision {
  const d = decideBase(p);
  // auto 模式:把"需确认"的调用尽量在 AI 分类器之前快速放行(参考 快速路径②③)。
  if (d === "ask" && p.mode === "auto") {
    // 敏感目标/危险命令产生的 ask 不能被白名单或工作区编辑路径绕过——auto 下 Read ~/.ssh/id_rsa
    // 这类调用必须过分类器(gate 里敏感请求也交分类器,分类器对私钥读取会 BLOCK 转人工)。
    if (isDangerousCall(p.toolName, p.argsJson) || isSensitiveTargetCall(p)) return "ask";
    if (AUTO_ALLOWLIST.has(p.toolName)) return "allow"; // ③ 安全白名单(只读类工具)
    if (autoEditAllow(p)) return "allow"; // ② 工作区内编辑(Edit/Write)自动放行
    return "ask"; // ④ 交分类器
  }
  return d;
}

// async 版本:Bash 工具用 AST 解析(精确子命令提取 + too-complex fail-closed)。
// 非 Bash 工具走同步 decide。
// 参考 bashToolHasPermission:步骤 0(AST parse)→ too-complex fail-closed → 规则匹配。
export async function decideAsync(p: DecideParams): Promise<Decision> {
  if (p.toolName !== "Bash") return decide(p);
  const id = toCcIdentity(p.toolName, p.argsJson);
  if (!id) return decide(p);

  // 动态 import:避免非 Bash 路径加载 AST 模块(~7000 行)
  const { evaluateWithAst } = await import("./rules.js");
  const ruleDec = await evaluateWithAst(p.rules, id);

  // 1. deny 规则:硬黑名单,任何模式(含 yolo)都拦截。
  if (ruleDec === "deny") return "deny";
  // 2. 危险 shell 命令:除 plan(只读,第 8 层一律 deny 更严)外任何模式(含 yolo)强制确认
  //    (除非显式 allow 规则 opt-in)。
  if (ruleDec !== "allow" && p.mode !== "plan" && isDangerousCall(p.toolName, p.argsJson)) return "ask";
  // 3. bypassPermissions(yolo):deny + 危险命令之外一律放行。
  if (p.mode === "bypassPermissions") return "allow";
  // 4. 敏感目标:default/auto 都返回 ask(default 强制人工;auto 交分类器——decide() 的 auto
  //    分支确认不被白名单绕过,gate 里敏感请求也交分类器而非人工);yolo(第 3 层已放行)/
  //    plan(第 8 层 deny 副作用)不拦。注意 Read 等非副作用工具也在这里拦:
  //    否则 auto 下 Read ~/.ssh/id_rsa 会从第 8 层直接 allow,绕过分类器。
  if (ruleDec !== "allow" && p.mode !== "plan" && isSensitiveTargetCall(p)) return "ask";
  // 5. ask 规则
  if (ruleDec === "ask") return "ask";
  // 6. allow 规则
  if (ruleDec === "allow") return "allow";

  // 7. 只读 shell 命令:不分模式一律快速放行,免一次审批(同 decideBase 的逻辑,这里 toolName 恒为
  //    Bash,已在函数顶部 return decide(p) 分流掉了非 Bash 的情况)。plan 除外(exec 一律 deny);
  //    敏感目标除外——auto 下 cat ~/.ssh/id_rsa 不能被只读快速路径放行,必须交分类器。
  if (p.mode !== "plan" && isReadOnlyShellCommand(extractCommand(p.argsJson)) && !isSensitiveTargetCall(p)) return "allow";

  // 8. 无规则命中 → 模式 + 能力默认
  const sideEffecting = p.capability === "write" || p.capability === "exec" || p.capability === "network";
  if (p.mode === "plan") return sideEffecting ? "deny" : "allow";
  if (p.mode === "auto" && sideEffecting) {
    if (AUTO_ALLOWLIST.has(p.toolName) && !isSensitiveTargetCall(p)) return "allow";
    if (autoEditAllow(p)) return "allow";
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

// 判断 auto 模式下的 Bash 调用是否被 dangerousPatterns 降级(危险 allow 规则命中)。
function isDangerousAutoAllow(p: DecideParams): boolean {
  if (p.toolName !== "Bash") return false;
  const id = toCcIdentity(p.toolName, p.argsJson);
  if (!id || id.ccTool !== "Bash") return false;
  return p.rules.allow.some((r) => {
    const parsed = parseRule(r);
    return parsed.tool === "Bash" && ruleMatches(parsed, id) && isDangerousBashPermission(parsed.specifier);
  });
}

// auto 模式快速路径②:工作区内文件编辑(Edit/Write)自动放行——原 acceptEdits 模式删除后,
// 把"文件编辑放行"语义直接内联进 auto 路径(等价于旧的 acceptEdits 重判)。
// 敏感目标/危险命令、显式 ask 规则除外——这些仍要确认。
function autoEditAllow(p: DecideParams): boolean {
  const id = toCcIdentity(p.toolName, p.argsJson);
  if (!id || (id.ccTool !== "Edit" && id.ccTool !== "Write")) return false;
  if (isDangerousCall(p.toolName, p.argsJson) || isSensitiveTargetCall(p)) return false;
  if (evaluate(p.rules, id) === "ask") return false;
  return true;
}

function decideBase(p: DecideParams): Decision {
  const id = toCcIdentity(p.toolName, p.argsJson);
  const ruleDec = id ? evaluate(p.rules, id) : null;

  // 1. deny 规则:硬黑名单,任何模式(含 yolo)都拦截。
  if (ruleDec === "deny") return "deny";
  // 2. 危险 shell 命令(rm -rf /、curl|sh、提权…):除 plan(只读,第 8 层一律 deny 更严)外
  //    任何模式(含 yolo)都要确认,除非显式 allow 规则 opt-in(ruleDec === "allow" 时跳过)。
  if (ruleDec !== "allow" && p.mode !== "plan" && isDangerousCall(p.toolName, p.argsJson)) return "ask";
  // 3. bypassPermissions(yolo):deny + 危险命令之外一律放行(用户已主动开启,自担其余风险)。
  if (p.mode === "bypassPermissions") return "allow";
  // 4. 敏感目标(凭据/只写敏感):default/auto 都返回 ask(default 强制人工;auto 交分类器,
  //    decide() 的 auto 分支确认不被白名单绕过);yolo(第 3 层已放行)/plan(第 8 层 deny)不拦。
  //    Read 等非副作用工具也在这里拦——否则 auto 下 Read ~/.ssh/id_rsa 从第 8 层直接 allow。
  if (ruleDec !== "allow" && p.mode !== "plan" && isSensitiveTargetCall(p)) return "ask";
  // 5. ask 规则
  if (ruleDec === "ask") return "ask";
  // 6. allow 规则
  if (ruleDec === "allow") {
    // auto 模式:危险的 Bash allow 规则(如 Bash(python:*))降级为 ask,交分类器判断。
    // 参考 CC stripDangerousPermissionsForAutoMode + isDangerousBashPermission。
    if (p.mode === "auto" && id?.ccTool === "Bash") {
      const hitRule = p.rules.allow.find((r) => {
        const parsed = parseRule(r);
        return parsed.tool === "Bash" && ruleMatches(parsed, id);
      });
      if (hitRule) {
        const spec = parseRule(hitRule).specifier;
        if (isDangerousBashPermission(spec)) return "ask";
      }
    }
    return "allow";
  }

  // 7. 只读 shell 命令(ls/cat/git status/find 不带 -delete…):不分模式一律快速放行,免一次审批——
  //    Bash 的 capability 标了 "exec" 不代表这次调用真有副作用,没道理因为工具本身的分类就问。
  //    plan 除外(只读规划,exec 一律 deny);敏感目标除外:auto 下 cat ~/.ssh/id_rsa 不能被
  //    只读快速路径放行,必须交分类器。
  if (p.mode !== "plan" && p.toolName === "Bash" && isReadOnlyShellCommand(extractCommand(p.argsJson)) && !isSensitiveTargetCall(p)) return "allow";

  // 8. 无规则命中 → 模式 + 能力默认
  const sideEffecting = p.capability === "write" || p.capability === "exec" || p.capability === "network";
  if (p.mode === "plan") return sideEffecting ? "deny" : "allow";
  if (p.mode === "auto" && sideEffecting) {
    // 敏感目标不享受白名单快速放行(白名单里 Read 会放掉 ~/.ssh/id_rsa)——须交分类器。
    if (AUTO_ALLOWLIST.has(p.toolName) && !isSensitiveTargetCall(p)) return "allow";
    if (autoEditAllow(p)) return "allow";
    return "ask";
  }
  return sideEffecting ? "ask" : "allow";
}
