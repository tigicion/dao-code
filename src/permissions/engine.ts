import type { Capability } from "../tools/types.js";
import { evaluate, type Decision } from "./rules.js";
import { toCcIdentity } from "./identity.js";
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

// 单次工具调用的权限裁决,1:1 复刻 CC 优先级:
//   deny 规则 > 安全敏感目标确认 > bypassPermissions > ask 规则 > allow 规则 > 模式/能力默认。
// deny 是硬黑名单,任何模式(含 bypass)都拦截。
export function decide(p: DecideParams): Decision {
  const id = toCcIdentity(p.toolName, p.argsJson);
  const ruleDec = id ? evaluate(p.rules, id) : null;

  if (ruleDec === "deny") return "deny";
  // CC 1g:写/执行触及安全敏感目标(.ssh/凭据/shell rc/.git/etc/.dao…)→ 即使 bypass/yolo/acceptEdits
  // 也要确认,防误删/泄密/破坏环境;除非有显式 allow 规则放行(用户可 opt-in)。target=路径或命令。
  if (ruleDec !== "allow" && (p.capability === "write" || p.capability === "exec") && id?.value && SENSITIVE_TARGET.test(id.value)) {
    return "ask";
  }
  if (p.mode === "bypassPermissions") return "allow";
  if (ruleDec === "ask") return "ask";
  if (ruleDec === "allow") return "allow";

  // 无规则命中 → 模式 + 能力默认
  const sideEffecting = p.capability === "write" || p.capability === "exec" || p.capability === "network";
  if (p.mode === "plan") return sideEffecting ? "deny" : "allow";
  if (p.mode === "acceptEdits" && id && (id.ccTool === "Edit" || id.ccTool === "Write")) return "allow";
  return sideEffecting ? "ask" : "allow";
}
