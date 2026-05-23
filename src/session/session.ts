import type { ChatMessage, Usage } from "../client/types.js";
import type { Mode } from "../tools/tools_for_mode.js";

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
  private readonly systemPrompt: string;

  constructor(systemPrompt: string, model: string) {
    this.systemPrompt = systemPrompt;
    this.model = model;
    this.messages = [{ role: "system", content: systemPrompt }];
  }

  addUsage(u: Usage): void {
    this.usage.promptTokens += u.prompt_tokens ?? 0;
    this.usage.completionTokens += u.completion_tokens ?? 0;
    this.usage.cacheHitTokens += u.prompt_cache_hit_tokens ?? 0;
    this.usage.cacheMissTokens += u.prompt_cache_miss_tokens ?? 0;
  }

  // cache 命中 token 占输入 token 的比例(0–1)。无输入时返回 0。
  cacheHitRatio(): number {
    return this.usage.promptTokens > 0 ? this.usage.cacheHitTokens / this.usage.promptTokens : 0;
  }

  usageSummary(): string {
    const { promptTokens, completionTokens, cacheHitTokens } = this.usage;
    if (promptTokens === 0) return "本会话暂无 token 统计。";
    const pct = (this.cacheHitRatio() * 100).toFixed(1);
    return `本会话用量:输入 ${promptTokens} tok(cache 命中 ${cacheHitTokens},命中率 ${pct}%,命中部分约省 98% 费用)· 输出 ${completionTokens} tok`;
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
