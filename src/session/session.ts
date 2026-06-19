import type { ChatMessage, Usage } from "../client/types.js";
import type { Mode } from "../tools/tools_for_mode.js";
import { estimateCostByModel, formatCNY } from "./cost.js";

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

export class Session {
  messages: ChatMessage[];
  model: string;
  mode: Mode = "normal";
  // 本会话累计 token 用量(含 cache 命中/未命中),供 /cost 与退出摘要算命中率。
  readonly usage: UsageTotals = { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
  // B-2 按模型分桶用量(主模型 + flash 子任务分开),供更准的￥计费。
  private readonly modelUsage = new Map<string, UsageTotals>();
  // Q1 真实上下文 token:主模型最近一次调用的 prompt_tokens(比 chars/3 估算准,尤其中文)。供压缩触发用。
  lastPromptTokens?: number;
  // 主循环最近一次请求实际发出的 messages 长度(=已被 DeepSeek 缓存的前缀边界)。
  // 蒸馏据此 slice,只发已缓存的前缀(不含回合后追加的最终回应/中途注入),命中热缓存。
  lastSentLength = 0;
  private readonly systemPrompt: string;
  // P0-1 前缀缓存埋点:记录上一次 API 调用的输入规模与命中率,用于检测"前缀被改写导致命中骤降"。
  private lastCall?: { promptTokens: number; hitRatio: number };
  private cacheBustWarner?: (info: { from: number; to: number; promptTokens: number; changed: string[] }) => void;
  // P1-47 缓存归因:记录每次请求的"影响缓存的前缀维度"指纹(模型/系统提示/工具集/尾部注入),
  // 命中骤降时对比上一次,指出是哪一维变了(便于定位"谁破了缓存")。
  private prevFp?: Record<string, string>;
  private curFp?: Record<string, string>;

  constructor(systemPrompt: string, model: string) {
    this.systemPrompt = systemPrompt;
    this.model = model;
    this.messages = [{ role: "system", content: systemPrompt }];
  }

  // 注册"前缀缓存疑似被破"回调(--verbose 下打日志)。前缀缓存是 dao 的成本差异化,
  // 命中骤降通常意味着压缩/注入意外改写了消息前缀——埋点让这种回归可见。
  onCacheBust(fn: (info: { from: number; to: number; promptTokens: number; changed: string[] }) => void): void {
    this.cacheBustWarner = fn;
  }

  // 每次请求前由 loop 调用:登记本次影响缓存的维度指纹(值应为短哈希/标识)。
  notePrefix(fp: Record<string, string>): void {
    this.prevFp = this.curFp;
    this.curFp = fp;
  }

  addUsage(u: Usage, model: string = this.model): void {
    this.usage.promptTokens += u.prompt_tokens ?? 0;
    this.usage.completionTokens += u.completion_tokens ?? 0;
    this.usage.cacheHitTokens += u.prompt_cache_hit_tokens ?? 0;
    this.usage.cacheMissTokens += u.prompt_cache_miss_tokens ?? 0;
    // B-2 按模型累加(用于分模型计价)。
    const b = this.modelUsage.get(model) ?? { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
    b.promptTokens += u.prompt_tokens ?? 0;
    b.completionTokens += u.completion_tokens ?? 0;
    b.cacheHitTokens += u.prompt_cache_hit_tokens ?? 0;
    b.cacheMissTokens += u.prompt_cache_miss_tokens ?? 0;
    this.modelUsage.set(model, b);
    // Q1:记录主模型的真实输入 token(= 当前上下文规模),供压缩触发用真实值而非估算。
    if (model === this.model && u.prompt_tokens) this.lastPromptTokens = u.prompt_tokens;

    // 本次调用的命中率;只在"输入够大(非首问/短问)"时参与骤降判定,避免误报。
    const prompt = u.prompt_tokens ?? 0;
    const ratio = prompt > 0 ? (u.prompt_cache_hit_tokens ?? 0) / prompt : 0;
    if (prompt >= 4000) {
      // 上一回合命中高(前缀健康)、本回合骤降 ≥0.5 → 多半是前缀被改写。
      if (this.lastCall && this.lastCall.hitRatio >= 0.5 && this.lastCall.hitRatio - ratio >= 0.5) {
        this.cacheBustWarner?.({ from: this.lastCall.hitRatio, to: ratio, promptTokens: prompt, changed: this.changedDims() });
      }
      this.lastCall = { promptTokens: prompt, hitRatio: ratio };
    }
  }

  // 对比相邻两次请求的前缀指纹,返回变化的维度名(归因)。
  private changedDims(): string[] {
    if (!this.prevFp || !this.curFp) return [];
    const keys = new Set([...Object.keys(this.prevFp), ...Object.keys(this.curFp)]);
    return [...keys].filter((k) => this.prevFp![k] !== this.curFp![k]);
  }

  // cache 命中 token 占输入 token 的比例(0–1)。无输入时返回 0。
  cacheHitRatio(): number {
    return this.usage.promptTokens > 0 ? this.usage.cacheHitTokens / this.usage.promptTokens : 0;
  }

  // P3-17/B-2 估算本会话￥成本:按模型分桶分别计价后相加(见 cost.ts)。
  costCNY(): number {
    return estimateCostByModel(this.modelUsage);
  }

  // 预算【提醒阈值】(￥,可选):设了且累计成本超过它 → overBudget()=true,循环据此提醒一次。
  // 默认不硬停(把决定权留给用户);仅 DAO_MAX_BUDGET_HARD=1 才停。
  budgetCNY?: number;
  overBudget(): boolean {
    return this.budgetCNY !== undefined && this.costCNY() >= this.budgetCNY;
  }

  usageSummary(): string {
    const { promptTokens, completionTokens, cacheHitTokens } = this.usage;
    if (promptTokens === 0) return "本会话暂无 token 统计。";
    const pct = (this.cacheHitRatio() * 100).toFixed(1);
    const cost = formatCNY(this.costCNY());
    return `本会话用量:输入 ${promptTokens} tok(cache 命中 ${cacheHitTokens},命中率 ${pct}%)· 输出 ${completionTokens} tok · 约 ${cost}${this.budgetCNY !== undefined ? `(提醒阈值 ${formatCNY(this.budgetCNY)})` : ""}`;
  }

  addUser(text: string): void {
    this.messages.push({ role: "user", content: text });
  }

  clear(): void {
    this.messages = [{ role: "system", content: this.systemPrompt }];
  }

  setModel(model: string): void {
    this.model = model;
  }

  toggleMode(): Mode {
    this.mode = this.mode === "normal" ? "plan" : "normal";
    return this.mode;
  }
}
