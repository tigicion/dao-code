import { describe, it, expect } from "vitest";
import { formatExtractReport, formatRecallReport } from "./report.js";

describe("report 格式化", () => {
  it("提取报告含画像召回与各 case", () => {
    const out = formatExtractReport([{ case: "slide", score: { factRecall: 0.8, profileRecall: 0.5, precision: 1, quality: 0.9, qualityStdev: 0.1, typeScopeMatch: 1, perFact: [] } }]);
    expect(out).toContain("slide");
    expect(out).toContain("画像召回");
    expect(out).toContain("0.5");
  });
  it("空抽取质量显示 N/A", () => {
    const out = formatExtractReport([{ case: "empty", score: { factRecall: 0, profileRecall: 0, precision: 1, quality: null, qualityStdev: null, typeScopeMatch: 0, perFact: [] } }]);
    expect(out).toContain("N/A");
    expect(out).toContain("type/scope");
  });
  it("召回报告含相关性缺口与 judge-人工一致度", () => {
    const out = formatRecallReport([{ case: "c1", score: { valuePR: { p: 1, r: 1, f1: 1 }, staleLeak: 0, relevanceGapValue: 0.33, judgeHumanAgreement: 0.8 } }]);
    expect(out).toContain("相关性缺口");
    expect(out).toContain("0.33");
    expect(out).toContain("judge-人工");
  });
});
