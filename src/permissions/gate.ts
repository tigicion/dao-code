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

  async requestBatch(requests: ApprovalRequest[]): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    // auto 模式:AI 分类器只负责【把确信安全的自动放行】;其余(判定需谨慎 / 评估失败 / 敏感目标)
    // 一律【转人工审批】,而不是直接拒绝——auto = "安全的自动过,拿不准的问你",绝不替你拒。
    // (只读类工具 / 只读 shell / 工作区内编辑已在 engine.decide 短路为 allow,根本不会到这。)
    let toAsk = requests;
    if (this.getMode() === "auto" && this.classify) {
      const needHuman: ApprovalRequest[] = [];
      for (const r of requests) {
        if (r.sensitive) { needHuman.push(r); continue; } // S3.1 敏感/危险:绝不交分类器
        let allow = false;
        try { allow = await this.classify(r.toolName, r.argsJson ?? ""); }
        catch { allow = false; } // 分类器评估失败 → 不自动放行,转人工(不是拒绝)
        if (allow) out.set(r.id, true);
        else needHuman.push(r);
      }
      if (needHuman.length === 0) return out;
      toAsk = needHuman; // 分类器拿不准的,继续走下面的人工审批
    }
    // 人工审批(default 模式全部走这;auto 模式只有分类器未放行的走这)。
    const decisions = await this.prompt(toAsk);
    for (const r of toAsk) {
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
