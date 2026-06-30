import type { ExtractScore } from "./extract.js";
import type { RecallScore } from "./recall.js";

export function formatExtractReport(rows: { case: string; score: ExtractScore }[]): string {
  const lines = ["# 提取效果报告", ""];
  for (const r of rows) {
    const s = r.score;
    lines.push(`## ${r.case}`,
      `- 事实召回:${s.factRecall.toFixed(2)}`,
      `- 画像召回:${s.profileRecall.toFixed(2)}`,
      `- 精确率(非噪声):${s.precision.toFixed(2)}`,
      `- 单条质量均分:${s.quality.toFixed(2)}`, "");
    for (const f of s.perFact) lines.push(`  · [${f.covered ? "✓" : "✗"} ${f.agreement.toFixed(2)}] ${f.fact}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function formatRecallReport(rows: { case: string; score: RecallScore }[]): string {
  const lines = ["# 召回效果报告", ""];
  for (const r of rows) {
    const s = r.score;
    lines.push(`## ${r.case}`,
      `- 价值 P/R/F1:${s.valuePR.p.toFixed(2)} / ${s.valuePR.r.toFixed(2)} / ${s.valuePR.f1.toFixed(2)}`,
      `- stale 泄漏(应为0):${s.staleLeak}`,
      `- 相关性缺口(诊断,越低越好):${s.relevanceGapValue.toFixed(2)}`, "");
  }
  return lines.join("\n");
}
