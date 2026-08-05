import type { Tool } from "../tools/types.js";
import type { ApprovalGate, ApprovalPrompt, ApprovalRequest, GateDecision } from "../approval/types.js";
import { decide, decideAsync } from "./engine.js";
import { rememberRule } from "./identity.js";
import type { PermissionsConfig, PermissionMode } from "./settings.js";
import type { ChatMessage } from "../client/types.js";

// 熔断阈值:连续 deny 达上限或总 deny 达上限时,
// auto 模式回退人工审批,不再调分类器(省 API 调用 + 避免卡死)。
// 30 分钟后自动重置(分类器可能因为换话题/改 prompt 后表现不同,不该永久熔断)。
const MAX_CONSECUTIVE_DENIALS = 3;
const MAX_TOTAL_DENIALS = 20;
const RESET_MS = 30 * 60 * 1000;

// CC 风格权限门:每次调用按规则+模式裁决(allow/ask/deny);ask 走交互,
// "always"->持久化一条 allow 规则,"session"->仅本会话放行同类调用。
export class PermissionGate implements ApprovalGate {
  constructor(
    private getMode: () => PermissionMode,
    private getRules: () => PermissionsConfig,
    private prompt: ApprovalPrompt,
    private onRemember: (rule: string) => Promise<void>, // 持久化到 settings.local.json
    private addSessionAllow: (rule: string) => void, // 加入本会话 allow(不落盘)
    private classify?: (toolName: string, argsJson: string, recentMessages: ChatMessage[]) => Promise<boolean>, // auto 模式:AI 代替人工裁决
    // 分类器上下文来源:必须是【当前裁决对象自己】的转录,不能写死。子代理走 withModeOverride
    // 时会传入 sub.messages——之前这里没有这个参数,子代理的调用永远用根 session.messages
    // 判定,分类器看不到子代理自己在做什么(复盘 session 20260721-215548-uq75)。
    private getMessages: () => ChatMessage[] = () => [],
    // 用户开启"敏感操作整体放行"子开关(autoSensitiveAllow)时持久化到 settings.local.json
    private onEnableSensitiveAllow: () => Promise<void> = async () => {},
  ) {}

  // 上一次 requestBatch 里,每个请求 id 最终是被分类器自动放行的,还是真弹窗问了人--
  // 供 execute.ts 写 perm-trace 时区分 source,而不是像以前一样两者混记成同一个 "ask"
  // (复盘 20260719-194639-mal7 时发现这个粒度缺失,没法回答"到底打扰了几次人")。
  // 每次 requestBatch 开头清空,只反映最近一批,避免长会话里无限增长。
  private lastSources = new Map<string, "classifier" | "human">();
  lastApprovalSource(id: string): "classifier" | "human" | undefined {
    return this.lastSources.get(id);
  }

  // 熔断状态。
  private consecutiveDenials = 0;
  private totalDenials = 0;
  private lastResetTime = Date.now();

  /** 分类器放行时调用:重置连续计数。 */
  recordClassifierAllow(): void {
    this.consecutiveDenials = 0;
  }

  // 熔断触发通知(一次性):跳闸的瞬间才写入,consumeTripNotice() 取走后清空——不重复打扰。
  // 复盘 session 20260721-215548-uq75:熔断后 DAO 静默降级到全人工、30 分钟后静默恢复,
  // 用户完全没有"auto 已失效"的提示,只能靠"怎么老在问我"自己反推。
  private pendingTripNotice: { consecutiveDenials: number; totalDenials: number } | null = null;
  private notifiedThisTrip = false;

  /** 分类器拒绝时调用:递增计数;首次达到熔断阈值时记一次待发通知。 */
  recordClassifierDenial(): void {
    this.consecutiveDenials++;
    this.totalDenials++;
    if (!this.notifiedThisTrip && (this.consecutiveDenials >= MAX_CONSECUTIVE_DENIALS || this.totalDenials >= MAX_TOTAL_DENIALS)) {
      this.notifiedThisTrip = true;
      this.pendingTripNotice = { consecutiveDenials: this.consecutiveDenials, totalDenials: this.totalDenials };
    }
  }

  /** 取走并清空待发的熔断通知;没有则返回 null。调用方(loop.ts)负责渲染给用户看。 */
  consumeTripNotice(): { consecutiveDenials: number; totalDenials: number } | null {
    const n = this.pendingTripNotice;
    this.pendingTripNotice = null;
    return n;
  }

  /** 是否已熔断(应回退人工,不再调分类器)。 */
  private isTripped(): boolean {
    if (Date.now() - this.lastResetTime > RESET_MS) {
      this.consecutiveDenials = 0;
      this.totalDenials = 0;
      this.lastResetTime = Date.now();
      this.notifiedThisTrip = false; // 计数清零后,下次再跳闸要能重新通知
    }
    return this.consecutiveDenials >= MAX_CONSECUTIVE_DENIALS
        || this.totalDenials >= MAX_TOTAL_DENIALS;
  }

  /**
   * 创建一个用指定 mode(及可选 transcript 来源)覆盖的子 gate(供子代理用)。
   * 规则/prompt/remember/classify 全部复用父级;裁决用的 mode、分类器看到的转录可以不同。
   * 参考 runAgent 中 agentGetAppState() 把 toolPermissionContext.mode 替换为 agentDef.permissionMode。
   * getMessages 不传时沿用父级的(向后兼容非子代理调用方)——子代理应始终传自己的 sub.messages,
   * 否则分类器还是看着父级(或更上层)的转录判子代理的调用,判断必然失真。
   */
  withModeOverride(mode: PermissionMode, getMessages?: () => ChatMessage[]): PermissionGate {
    return new PermissionGate(
      () => mode,
      this.getRules,
      this.prompt,
      this.onRemember,
      this.addSessionAllow,
      this.classify,
      getMessages ?? this.getMessages,
      this.onEnableSensitiveAllow,
    );
  }

  // 同步裁决:用于非 Bash 工具或 legacy 路径。
  decide(toolName: string, argsJson: string, tool: Tool): GateDecision {
    const d = decide({
      toolName,
      argsJson,
      capability: tool.capability,
      mode: this.getMode(),
      rules: this.getRules(),
    });
    if (d === "deny") return d;
    // 工具自检只能【收紧】(参考 1c–1f):escalate allow->ask、任意->deny;返回 null 不干预。
    const tc = tool.checkPermissions?.(argsJson);
    if (tc === "deny") return "deny";
    // yolo(bypassPermissions):deny 之外一律放行--工具自检的 ask 升级也不拦(用户已自担风险)。
    if (tc === "ask" && d === "allow" && this.getMode() !== "bypassPermissions") return "ask";
    return d;
  }

  // async 裁决:Bash 工具用 AST 解析(精确子命令提取 + too-complex fail-closed)。
  // 执行器应优先用这个;同步 decide 保留给不调用 evaluateWithAst 的路径。
  async decideAsync(toolName: string, argsJson: string, tool: Tool): Promise<GateDecision> {
    const d = await decideAsync({
      toolName,
      argsJson,
      capability: tool.capability,
      mode: this.getMode(),
      rules: this.getRules(),
    });
    if (d === "deny") return d;
    const tc = tool.checkPermissions?.(argsJson);
    if (tc === "deny") return "deny";
    if (tc === "ask" && d === "allow" && this.getMode() !== "bypassPermissions") return "ask";
    return d;
  }

  async requestBatch(requests: ApprovalRequest[]): Promise<Map<string, boolean>> {
    this.lastSources = new Map(); // 只反映这一批,不跨批累积
    const out = new Map<string, boolean>();
    // auto 模式:AI 分类器只负责【把确信安全的自动放行】;其余(判定需谨慎 / 评估失败 / 敏感目标)
    // 一律【转人工审批】,而不是直接拒绝--auto = "安全的自动过,拿不准的问你",绝不替你拒。
    // (只读类工具 / 只读 shell / 工作区内编辑已在 engine.decide 短路为 allow,根本不会到这。)
    let toAsk = requests;
    if (this.getMode() === "auto" && this.classify) {
      const needHuman: ApprovalRequest[] = [];
      // 熔断检查:连续/总 deny 超限时跳过分类器,全部转人工。
      const tripped = this.isTripped();
      const subEnabled = this.getRules().autoSensitiveAllow === true;
      for (const r of requests) {
        if (r.sensitive || tripped) {
          // 子开关未开 + 非极端危险:标记"可开启整体放行",审批界面据此提供选项;
          // 极端危险命令(dangerous)即使子开关开启也仍要确认,不提供开启选项。
          needHuman.push(subEnabled || r.dangerous ? r : { ...r, offerSensitiveAllow: true });
          continue;
        } // 敏感/危险 或已熔断:绝不交分类器
        let allow = false;
        try { allow = await this.classify(r.toolName, r.argsJson ?? "", this.getMessages()); }
        catch { allow = false; } // 分类器评估失败 -> 不自动放行,转人工(不是拒绝)
        if (allow) {
          out.set(r.id, true);
          this.lastSources.set(r.id, "classifier");
          this.recordClassifierAllow();
        } else {
          this.recordClassifierDenial();
          needHuman.push(r);
        }
      }
      if (needHuman.length === 0) return out;
      toAsk = needHuman; // 分类器拿不准的,继续走下面的人工审批
    }
    // 人工审批(default 模式全部走这;auto 模式只有分类器未放行的走这)。
    const decisions = await this.prompt(toAsk);
    for (const r of toAsk) {
      const d = decisions.get(r.id) ?? "deny";
      // 用户选了"开启敏感操作整体放行"且尚未开启:持久化子开关,本次也放行。
      if (d === "always" && r.offerSensitiveAllow && this.getRules().autoSensitiveAllow !== true) {
        await this.onEnableSensitiveAllow();
        this.lastSources.set(r.id, "human");
        out.set(r.id, true);
        continue;
      }
      if ((d === "always" || d === "session") && r.argsJson !== undefined) {
        // 普通操作加白:记规则(同类不再问)。
        const rule = rememberRule(r.toolName, r.argsJson);
        if (rule) {
          this.addSessionAllow(rule);
          if (d === "always") await this.onRemember(rule);
        }
      }
      this.lastSources.set(r.id, "human");
      out.set(r.id, d !== "deny");
    }
    return out;
  }
}
