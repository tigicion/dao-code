// 召回轴 A/B:push(现状,src/memory/inject.ts 的两层读取)vs pull(CC 风格,仅索引、模型自己决定读哪条)。
// allLiveTitles 是 pull 轴的"注入集"——不像 selectFullText 那样给 user/feedback/locked 全文特权,
// 一律只留标题,逼近 CC「只有 MEMORY.md 索引常驻,模型主动 Read 单条」的设计。
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Memory } from "../../src/memory/types.js";
import type { Verdict } from "../../src/memory/validate.js";
import { loadAllMemories, routeScope, keepKnowledgeForProject } from "../../src/memory/store.js";
import { selectForInjection } from "../../src/memory/inject.js";
import { validateMemory } from "../../src/memory/validate.js";
import { judgeBool, pullWorthyPrompt } from "./lib/judge.js";
import { precisionRecall } from "./lib/metrics.js";
import type { RecallContext, EvalConfig } from "./lib/types.js";

export function allLiveTitles(items: { mem: Memory; verdict: Verdict }[]): string[] {
  return items.filter((x) => x.verdict !== "stale").map((x) => x.mem.title || x.mem.name);
}

export interface InjectionABScore {
  push: { p: number; r: number; f1: number };
  pull: { p: number; r: number; f1: number };
  delta: number; // push.r - pull.r:正数=pull 比 push 漏召回更多
}

// 纯逻辑部分:push 轴直接用已算好的注入集对 valueGold 算 P/R(与 recall.ts 的 valuePR 同一算法);
// pull 轴对每个候选 title 逐条 judge("只给标题,你会不会去读"),judge=true 的集合视为"被检索到"。
// 注意:pullTitles 的元素必须能直接和 ctx.valueGold(存的是 name)比较——调用方(runInjectionABCase)
// 负责把 title 映射回 name 再传进来;这个函数本身不做映射,保持纯粹可测。
export async function gradeInjectionAB(p: {
  pushInjectedNames: string[]; pullTitles: string[]; ctx: RecallContext;
  streamChat: (o: any) => AsyncGenerator<any, any>; cfg: EvalConfig;
}): Promise<InjectionABScore> {
  const push = precisionRecall(new Set(p.pushInjectedNames), new Set(p.ctx.valueGold));
  const pullSelected = new Set<string>();
  for (const title of p.pullTitles) {
    const v = await judgeBool({ streamChat: p.streamChat, cfg: p.cfg, prompt: pullWorthyPrompt(p.ctx.task, title), key: "wouldRead" }, p.cfg.judgeK);
    if (v.value) pullSelected.add(title);
  }
  const pull = precisionRecall(pullSelected, new Set(p.ctx.valueGold));
  return { push, pull, delta: push.r - pull.r };
}

// 整合入口:加载 fixture、走 validate/项目过滤(镜像 recall.ts.runRecallCase),
// 分别算 push 轴(selectForInjection 的注入集)与 pull 轴(allLiveTitles,按 name 而非展示 title 传给 judge——
// judge rubric 只是要"一段可读的标识",用 name 代替展示 title 不影响判断质量,却让结果能直接和 valueGold 比对)。
// RecallContext 本身没有 projectId 字段,fixture 的 context.json 可能带它做 knowledge 层过滤,故此处局部放宽类型。
export async function runInjectionABCase(dir: string, streamChat: (o: any) => AsyncGenerator<any, any>, cfg: EvalConfig): Promise<InjectionABScore> {
  const ctx = JSON.parse(await fs.readFile(path.join(dir, "context.json"), "utf8")) as RecallContext & { projectId?: string };
  const storeDir = path.join(dir, "store");
  const today = new Date().toISOString().slice(0, 10);
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "eval-injection-ab-"));
  let mems = await loadAllMemories(storeDir);
  if (ctx.projectId) {
    mems = mems.filter((m) => routeScope(m.type) !== "knowledge" || keepKnowledgeForProject(m, ctx.projectId!));
  }
  const validated: { mem: Memory; verdict: Verdict }[] = [];
  for (const m of mems) { const { verdict } = await validateMemory(m, ws, today); validated.push({ mem: m, verdict }); }
  const pushInjectedNames = selectForInjection(validated, today).map((v) => v.mem.name);
  const pullTitles = validated.filter((v) => v.verdict !== "stale").map((v) => v.mem.name); // 用 name,不用展示 title(见上注释)
  return gradeInjectionAB({ pushInjectedNames, pullTitles, ctx, streamChat, cfg });
}
