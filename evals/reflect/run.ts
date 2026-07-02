#!/usr/bin/env tsx
// 反思评测跑批:tsx evals/reflect/run.ts
// 前提:dao 已配 profile(/login 或 ~/.dao/config.json)。真实模型、非 CI。
// 衡量反思器在"该报警"时报警(recall)、"没问题"时别乱报(precision),以及 advisory 是否点到点子上。
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { streamChat } from "../../src/client/client.js";
import { loadEvalConfig } from "../memory/lib/creds.js";
import { precisionRecall } from "../memory/lib/metrics.js";
import { runReflectCase, type ReflectScore } from "./grade.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function listCases(): Promise<string[]> {
  const base = path.join(__dirname, "fixtures");
  const names = await fs.readdir(base).catch(() => []);
  const dirs: string[] = [];
  for (const n of names) { const p = path.join(base, n); if ((await fs.stat(p)).isDirectory()) dirs.push(p); }
  return dirs.sort();
}

function formatReport(rows: { case: string; gold: any; score: ReflectScore }[]): string {
  const lines = ["# 反思评测(reflect eval)\n", "| 用例 | 期望 | 实得 | onTrack 命中 | advisory 点中 |", "|---|---|---|---|---|"];
  // flag = "该报警"(!onTrack)。预测=!gotOnTrack,金标=!expectOnTrack。算 flag 的 P/R。
  const predicted = new Set<string>();
  const gold = new Set<string>();
  const onPoints: number[] = [];
  for (const r of rows) {
    if (!r.score.gotOnTrack) predicted.add(r.case);
    if (!r.gold.expectOnTrack) gold.add(r.case);
    if (r.score.advisoryOnPoint !== null) onPoints.push(r.score.advisoryOnPoint);
    const exp = r.gold.expectOnTrack ? "在轨" : "报警";
    const got = r.score.gotOnTrack ? "在轨" : "报警";
    const op = r.score.advisoryOnPoint === null ? "—" : r.score.advisoryOnPoint === 1 ? "✅" : "❌";
    lines.push(`| ${r.case} | ${exp} | ${got} | ${r.score.onTrackMatch ? "✅" : "❌"} | ${op} |`);
  }
  const pr = precisionRecall(predicted, gold); // "报警"这一类的 P/R
  const onPointMean = onPoints.length ? onPoints.reduce((a, b) => a + b, 0) / onPoints.length : null;
  lines.push("");
  lines.push(`报警 precision=${pr.p.toFixed(2)} recall=${pr.r.toFixed(2)} f1=${pr.f1.toFixed(2)}`);
  lines.push(`advisory 点中率(仅报警用例)=${onPointMean === null ? "N/A" : onPointMean.toFixed(2)}`);
  lines.push(`\n注:precision 低=乱报(误伤在轨用例),recall 低=漏报(该纠没纠,即"橡皮图章")。需正控用例(expectOnTrack=true)才能测 precision。`);
  return lines.join("\n");
}

async function main() {
  const cfg = await loadEvalConfig();
  const sc = streamChat as any;
  const rows: { case: string; gold: any; score: ReflectScore }[] = [];
  for (const dir of await listCases()) {
    const gold = JSON.parse(await fs.readFile(path.join(dir, "gold.json"), "utf8"));
    const score = await runReflectCase(dir, sc, cfg);
    rows.push({ case: path.basename(dir), gold, score });
  }
  const report = formatReport(rows);
  await fs.writeFile(path.join(__dirname, "report.md"), report, "utf8");
  console.log(report);
}
main().catch((e) => { console.error(e); process.exit(1); });
