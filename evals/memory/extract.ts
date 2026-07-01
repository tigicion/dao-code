import { promises as fs } from "node:fs";
import path from "node:path";
import { reflect } from "../../src/agent/unified_reflect.js";
import { parseJsonl, toMessages, windowMessages } from "./lib/transcript.js";
import { judgeBool, judgeOnce, factCoveredPrompt, memoryQualityPrompt } from "./lib/judge.js";
import { aggregate } from "./lib/metrics.js";
import { routeScope } from "../../src/memory/store.js";
import type { MemoryType } from "../../src/memory/types.js";
import type { EvalConfig, ExtractGold } from "./lib/types.js";

export interface ExtractScore {
  factRecall: number; profileRecall: number | null; precision: number | null;
  quality: number | null; qualityStdev: number | null;
  typeScopeMatch: number;
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
  const profileRecall = profs.length ? profs.filter((x) => x.covered).length / profs.length : null; // 无画像金标 → N/A,不谄媚假 1.0
  // 2) mustNot 精确率:抽出的每条,逐条噪声探测,命中任一即误抽(不再把噪声拼成一条,避免只命中其一时 judge 偏 false 漏判)
  let noise = 0;
  for (const m of p.extracted) {
    let hit = false;
    for (const noiseDesc of p.gold.mustNot) {
      const v = await judgeBool({ streamChat: p.streamChat, cfg: p.cfg,
        prompt: factCoveredPrompt({ text: noiseDesc, type: "episodic", scope: "project" }, [m]), key: "covered" }, K);
      if (v.value) { hit = true; break; }
    }
    if (hit) noise++;
  }
  const precision = p.extracted.length ? 1 - noise / p.extracted.length : null; // 无抽出 → N/A,不谄媚假 1.0
  // 3) 单条质量:每条 judge K 次(judgeOnce),四维均值入样本池;中位为主 + 方差;空抽取→null(不谄媚)
  const qs: number[] = [];
  for (const m of p.extracted) {
    for (let k = 0; k < K; k++) {
      const j = await judgeOnce({ streamChat: p.streamChat, cfg: p.cfg, prompt: memoryQualityPrompt(m) });
      if (j) {
        const dims = ["durable", "typeScopeCorrect", "notCatalogDump", "actionable"].map((kk) => Number(j[kk] ?? 0));
        qs.push(dims.reduce((a, b) => a + b, 0) / dims.length);
      }
    }
  }
  const agg = qs.length ? aggregate(qs) : null;
  const quality = agg ? agg.median : null;
  const qualityStdev = agg ? agg.stdev : null;
  // 4) 确定性 type/scope:每条金标事实,是否有抽出记忆落在期望 scope(routeScope(type))
  const typeScopeMatch = p.gold.mustExtract.length
    ? p.gold.mustExtract.filter((f) => p.extracted.some((m) => routeScope(m.type as MemoryType) === f.scope)).length / p.gold.mustExtract.length
    : 1;
  return { factRecall, profileRecall, precision, quality, qualityStdev, typeScopeMatch, perFact: perFact.map(({ fact, covered, agreement }) => ({ fact, covered, agreement })) };
}

export async function runExtractCase(dir: string, streamChat: (o: any) => AsyncGenerator<any, any>, cfg: EvalConfig): Promise<ExtractScore> {
  const gold = JSON.parse(await fs.readFile(path.join(dir, "gold.json"), "utf8")) as ExtractGold;
  const events = parseJsonl(await fs.readFile(path.join(dir, "conversation.jsonl"), "utf8"));
  const messages = windowMessages(toMessages(events));
  const today = new Date().toISOString().slice(0, 10);
  // fork:true + 推理:对齐线上 reflect 的实际配置(fork:false 会关思考、结构不同,不代表生产)。
  const result = await reflect({ streamChat, config: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey }, model: cfg.model, messages, existing: gold.existing, today, fork: true, reasoningEffort: "high" } as any);
  const extracted = result.memories.map((m: any) => ({ title: m.title, text: m.text, type: m.type }));
  return gradeExtraction({ extracted, gold, streamChat, cfg });
}
