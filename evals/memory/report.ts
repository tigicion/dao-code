import type { ExtractScore } from "./extract.js";
import type { RecallScore } from "./recall.js";

export function formatExtractReport(rows: { case: string; score: ExtractScore }[]): string {
  const lines = ["# 提取效果报告", "", "> 注:抽取单采样;judge K 次取中位。数字为参考。", ""];
  for (const r of rows) {
    const s = r.score;
    lines.push(`## ${r.case}`,
      `- 事实召回:${s.factRecall.toFixed(2)}`,
      `- 画像召回:${s.profileRecall.toFixed(2)}`,
      `- 精确率(非噪声):${s.precision.toFixed(2)}`,
      `- 单条质量(中位±方差):${s.quality === null ? "N/A(无抽出)" : `${s.quality.toFixed(2)} ±${(s.qualityStdev ?? 0).toFixed(2)}`}`,
      `- type/scope 命中率(确定性):${s.typeScopeMatch.toFixed(2)}`, "");
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
      `- 相关性缺口(对人工金标,诊断,越低越好):${s.relevanceGapValue.toFixed(2)}`,
      `- judge-人工相关性一致度 F1(诊断):${s.judgeHumanAgreement.toFixed(2)}`, "");
  }
  return lines.join("\n");
}
