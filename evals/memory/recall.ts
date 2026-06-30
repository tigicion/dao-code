import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAllMemories } from "../../src/memory/store.js";
import { selectForInjection } from "../../src/memory/inject.js";
import { validateMemory } from "../../src/memory/validate.js";
import { judgeBool, relevancePrompt } from "./lib/judge.js";
import { precisionRecall, relevanceGap } from "./lib/metrics.js";
import type { EvalConfig, RecallContext } from "./lib/types.js";

export interface RecallScore { valuePR: { p: number; r: number; f1: number }; staleLeak: number; relevanceGapValue: number; }

export async function gradeRecall(p: {
  injectedNames: string[]; staleNames: string[];
  store: { name: string; text: string }[]; ctx: RecallContext;
  streamChat: (o: any) => AsyncGenerator<any, any>; cfg: EvalConfig;
}): Promise<RecallScore> {
  const injected = new Set(p.injectedNames);
  // A 轨:valueGold P/R + stale 泄漏(硬规则:stale 不该在注入集)
  const valuePR = precisionRecall(injected, new Set(p.ctx.valueGold));
  const staleLeak = p.staleNames.filter((n) => injected.has(n)).length;
  // B 轨:judge 判 store 每条是否语境相关 → 相关集;相关但未注入 = 缺口
  const relevant = new Set<string>();
  for (const m of p.store) {
    const v = await judgeBool({ streamChat: p.streamChat, cfg: p.cfg, prompt: relevancePrompt(p.ctx.task, m.text), key: "relevant" }, p.cfg.judgeK);
    if (v.value) relevant.add(m.name);
  }
  const relevanceGapValue = relevanceGap(injected, relevant);
  return { valuePR, staleLeak, relevanceGapValue };
}

export async function runRecallCase(dir: string, streamChat: (o: any) => AsyncGenerator<any, any>, cfg: EvalConfig): Promise<RecallScore> {
  const ctx = JSON.parse(await fs.readFile(path.join(dir, "context.json"), "utf8")) as RecallContext;
  const storeDir = path.join(dir, "store");
  const today = new Date().toISOString().slice(0, 10);
  // 临时工作区:让 validateMemory 在无 source 时判 ok(fixture 记忆一般无 source)
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "eval-recall-"));
  const mems = await loadAllMemories(storeDir);
  const validated: { mem: any; verdict: string }[] = [];
  for (const m of mems) { const { verdict } = await validateMemory(m, ws, today); validated.push({ mem: m, verdict }); }
  const staleNames = validated.filter((v) => v.verdict === "stale").map((v) => v.mem.name);
  const injected = selectForInjection(validated as any, today).map((v: any) => v.mem.name);
  const store = mems.map((m: any) => ({ name: m.name, text: m.text }));
  return gradeRecall({ injectedNames: injected, staleNames, store, ctx, streamChat, cfg });
}
