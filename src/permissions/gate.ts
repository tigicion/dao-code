import type { Tool } from "../tools/types.js";
import type { ApprovalGate, ApprovalPrompt, ApprovalRequest, GateDecision } from "../approval/types.js";
import { decide } from "./engine.js";
import { rememberRule } from "./identity.js";
import type { PermissionsConfig, PermissionMode } from "./settings.js";

// CC 风格权限门:每次调用按规则+模式裁决(allow/ask/deny);ask 走交互,
// "always"→持久化一条 allow 规则,"session"→仅本会话放行同类调用。
export class PermissionGate implements ApprovalGate {
  constructor(
    private getMode: () => PermissionMode,
    private getRules: () => PermissionsConfig,
    private prompt: ApprovalPrompt,
    private onRemember: (rule: string) => Promise<void>, // 持久化到 settings.local.json
    private addSessionAllow: (rule: string) => void, // 加入本会话 allow(不落盘)
    private classify?: (toolName: string, argsJson: string) => Promise<boolean>, // auto 模式:AI 代替人工裁决
  ) {}

  decide(toolName: string, argsJson: string, tool: Tool): GateDecision {
    const d = decide({
      toolName,
      argsJson,
      capability: tool.capability,
      mode: this.getMode(),
      rules: this.getRules(),
    });
    if (d === "deny") return d;
    // 工具自检只能【收紧】(对标 CC 1c–1f):escalate allow→ask、任意→deny;返回 null 不干预。
    const tc = tool.checkPermissions?.(argsJson);
    if (tc === "deny") return "deny";
    // yolo(bypassPermissions):deny 之外一律放行——工具自检的 ask 升级也不拦(用户已自担风险)。
    if (tc === "ask" && d === "allow" && this.getMode() !== "bypassPermissions") return "ask";
    return d;
  }

  // auto 模式拒绝跟踪(对标 CC denialTracking):连续拒绝/累计拒绝达阈值 → 回退人工审批,防分类器误杀卡死。
  private consecutiveDenials = 0;
  private cumulativeDenials = 0;
  private static readonly CONSECUTIVE_LIMIT = 3;
  private static readonly CUMULATIVE_LIMIT = 20;

  async requestBatch(requests: ApprovalRequest[]): Promise<Map<string, boolean>> {
    // auto 模式:用 AI 分类器代替人工逐一裁决(出错保守拒绝,对标 fail-closed);不持久化规则(每次重判)。
    if (this.getMode() === "auto" && this.classify) {
      const out = new Map<string, boolean>();
      const needHuman: ApprovalRequest[] = [];
      for (const r of requests) {
        // S3.1:敏感目标/危险命令绝不交给分类器自动放行——直接走人工(即便 auto 模式)。
        if (r.sensitive) { needHuman.push(r); continue; }
        // 熔断:连续≥3 或 累计≥20 次拒绝 → 该请求回退人工审批(保留分类器已做的判断不丢)。
        if (this.consecutiveDenials >= PermissionGate.CONSECUTIVE_LIMIT || this.cumulativeDenials >= PermissionGate.CUMULATIVE_LIMIT) {
          if (this.cumulativeDenials >= PermissionGate.CUMULATIVE_LIMIT) this.cumulativeDenials = 0; // 累计触发后重置
          needHuman.push(r);
          continue;
        }
        const allow = await this.classify!(r.toolName, r.argsJson ?? "").catch(() => false);
        if (allow) { this.consecutiveDenials = 0; out.set(r.id, true); }
        else { this.consecutiveDenials++; this.cumulativeDenials++; out.set(r.id, false); }
      }
      if (needHuman.length) {
        const decisions = await this.prompt(needHuman);
        for (const r of needHuman) {
          const allow = (decisions.get(r.id) ?? "deny") !== "deny";
          if (allow) this.consecutiveDenials = 0;
          out.set(r.id, allow);
        }
      }
      return out;
    }
    const decisions = await this.prompt(requests);
    const out = new Map<string, boolean>();
    for (const r of requests) {
      const d = decisions.get(r.id) ?? "deny";
      if ((d === "always" || d === "session") && r.argsJson !== undefined) {
        const rule = rememberRule(r.toolName, r.argsJson);
        if (rule) {
          this.addSessionAllow(rule);
          if (d === "always") await this.onRemember(rule);
        }
      }
      out.set(r.id, d !== "deny");
    }
    return out;
  }
}
