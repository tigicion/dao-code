import { promises as fs } from "node:fs";
import path from "node:path";
import { reflect } from "../../src/agent/unified_reflect.js";
import { parseJsonl, toMessages, windowMessages } from "./lib/transcript.js";
import { judgeBool, judgeOnce, factCoveredPrompt, memoryQualityPrompt } from "./lib/judge.js";
import { aggregate } from "./lib/metrics.js";
import type { EvalConfig, ExtractGold } from "./lib/types.js";

export interface ExtractScore {
  factRecall: number; profileRecall: number; precision: number; quality: number;
  perFact: { fact: string; covered: boolean; agreement: number }[];
}

export async function gradeExtraction(p: {
  extracted: { title?: string; text: string; type: string }[];
  gold: ExtractGold; streamChat: (o: any) => AsyncGenerator<any, any>; cfg: EvalConfig;
}): Promise<ExtractScore> {
  const K = p.cfg.judgeK;
  // 1) mustExtract 覆盖(逐条 judge 多数票)
  const perFact: { fact: string; covered: boolean; agreement: number; profile: boolean }[] = [];
  for (const f of p.gold.mustExtract) {
    const v = await judgeBool({ streamChat: p.streamChat, cfg: p.cfg, prompt: factCoveredPrompt(f, p.extracted), key: "covered" }, K);
    perFact.push({ fact: f.text, covered: v.value, agreement: v.agreement, profile: !!f.profile });
  }
  const factRecall = p.gold.mustExtract.length ? perFact.filter((x) => x.covered).length / p.gold.mustExtract.length : 1;
  const profs = perFact.filter((x) => x.profile);
  const profileRecall = profs.length ? profs.filter((x) => x.covered).length / profs.length : 1;
  // 2) mustNot 精确率:抽出的每条若命中任一 mustNot 噪声描述则算误抽
  let noise = 0;
  for (const m of p.extracted) {
    const goldNoise = { existing: [], mustExtract: [], mustNot: p.gold.mustNot };
    const hit = p.gold.mustNot.length
      ? (await judgeBool({ streamChat: p.streamChat, cfg: p.cfg,
          prompt: factCoveredPrompt({ text: "以下任一噪声描述:" + p.gold.mustNot.join(";"), type: "episodic", scope: "project" }, [m]),
          key: "covered" }, K)).value
      : false;
    if (hit) noise++;
    void goldNoise;
  }
  const precision = p.extracted.length ? 1 - noise / p.extracted.length : 1;
  // 3) 单条质量(judge 一次取四维度均值,再对所有记忆取均值)
  const qs: number[] = [];
  for (const m of p.extracted) {
    const j = await judgeOnce({ streamChat: p.streamChat, cfg: p.cfg, prompt: memoryQualityPrompt(m) });
    if (j) {
      const dims = ["durable", "typeScopeCorrect", "notCatalogDump", "actionable"].map((k) => Number(j[k] ?? 0));
      qs.push(dims.reduce((a, b) => a + b, 0) / dims.length);
    }
  }
  const quality = qs.length ? aggregate(qs).mean : 1;
  return { factRecall, profileRecall, precision, quality, perFact: perFact.map(({ fact, covered, agreement }) => ({ fact, covered, agreement })) };
}

export async function runExtractCase(dir: string, streamChat: (o: any) => AsyncGenerator<any, any>, cfg: EvalConfig): Promise<ExtractScore> {
  const gold = JSON.parse(await fs.readFile(path.join(dir, "gold.json"), "utf8")) as ExtractGold;
  const events = parseJsonl(await fs.readFile(path.join(dir, "conversation.jsonl"), "utf8"));
  const messages = windowMessages(toMessages(events));
  const today = new Date().toISOString().slice(0, 10);
  const result = await reflect({ streamChat, config: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey }, model: cfg.model, messages, existing: gold.existing, today, fork: false } as any);
  const extracted = result.memories.map((m: any) => ({ title: m.title, text: m.text, type: m.type }));
  return gradeExtraction({ extracted, gold, streamChat, cfg });
}
