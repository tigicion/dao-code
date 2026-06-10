#!/usr/bin/env node
// METR 风格时间跨度(time horizon)分析。
// 读 evals/runs/*/run-*/meta.json,把每次运行当一个 trial(humanMinutes 标在 task.json),
// 对(完成度≥阈值, humanMinutes)做 logistic 拟合,输出 p50/p80 时间跨度(等效人类工时)。
//
// 用法:node evals/horizon.mjs            # 阈值默认 1.0(必须满分才算成功)
//       COMPLETION_THRESHOLD=0.8 node evals/horizon.mjs
//
// 注意(METR 的告诫):p50 跨度 ≠ 可安全委托的任务长度——真实部署常需 80%+ 可靠性,
// 所以 p80 比 p50 更适合当产品级指标。数据点少时置信区间极宽,数字仅供趋势参考。

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { metasToSamples, fitTimeHorizon } from "./score.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = path.join(__dirname, "runs");
const THRESHOLD = Number(process.env.COMPLETION_THRESHOLD || 1);

const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };
const fmtMin = (m) =>
  m == null ? "—" : m < 60 ? `${m.toFixed(0)} 分钟` : m < 1440 ? `${(m / 60).toFixed(1)} 小时` : `${(m / 1440).toFixed(1)} 天`;

async function loadMetas() {
  if (!(await exists(RUNS_DIR))) return [];
  const metas = [];
  for (const taskId of await fs.readdir(RUNS_DIR)) {
    const taskDir = path.join(RUNS_DIR, taskId);
    if (!(await fs.stat(taskDir)).isDirectory()) continue;
    for (const runName of await fs.readdir(taskDir)) {
      const mp = path.join(taskDir, runName, "meta.json");
      if (await exists(mp)) {
        try { metas.push(JSON.parse(await fs.readFile(mp, "utf8"))); } catch {}
      }
    }
  }
  return metas;
}

async function main() {
  const metas = await loadMetas();
  if (!metas.length) {
    console.error("没有 run 数据。先 node evals/run.mjs 跑一遍(任务需在 task.json 标注 humanMinutes)。");
    process.exit(1);
  }

  // 按任务汇总完成度概况
  const byTask = new Map();
  for (const m of metas) {
    if (!byTask.has(m.id)) byTask.set(m.id, { id: m.id, hm: m.humanMinutes, comps: [] });
    byTask.get(m.id).comps.push(m.completion ?? (m.pass ? 1 : 0));
  }

  console.log(`时间跨度分析  ·  完成度阈值 ${THRESHOLD}  ·  ${metas.length} 次运行 / ${byTask.size} 个任务\n`);
  const pad = (s, n) => String(s) + " ".repeat(Math.max(0, n - String(s).length));
  console.log(pad("任务", 26) + pad("人类工时", 12) + pad("平均完成度", 12) + "成功率(≥阈值)");
  for (const t of [...byTask.values()].sort((a, b) => (a.hm ?? 1e9) - (b.hm ?? 1e9))) {
    const avg = t.comps.reduce((a, b) => a + b, 0) / t.comps.length;
    const succ = t.comps.filter((c) => c >= THRESHOLD).length;
    console.log(
      pad(t.id, 26) + pad(fmtMin(t.hm), 12) +
      pad(`${(avg * 100).toFixed(0)}%`, 12) + `${succ}/${t.comps.length}`,
    );
  }

  const samples = metasToSamples(metas, THRESHOLD);
  const labeled = samples.length;
  console.log(`\n参与拟合的样本(已标注工时):${labeled} / ${metas.length}`);
  if (labeled < metas.length) {
    console.log(`(${metas.length - labeled} 次运行的任务未标注 humanMinutes,已剔除——给 task.json 加 "humanMinutes" 才能纳入)`);
  }

  const fit = fitTimeHorizon(samples);
  console.log(`\n${"─".repeat(56)}`);
  if (fit.degenerate) {
    console.log(`时间跨度:数据不足以拟合(${fit.reason || `${fit.nPos ?? 0} 成功 / ${fit.nNeg ?? 0} 失败,需各 ≥1 且总 ≥4 且有单调趋势`})。`);
    console.log(`先积累更多不同 humanMinutes 的任务、且有成功也有失败的样本,曲线才有意义。`);
  } else {
    console.log(`p50 时间跨度(50% 成功):${fmtMin(fit.p50)}`);
    console.log(`p80 时间跨度(80% 成功):${fmtMin(fit.p80)}   ← 产品级可靠性更该看这个`);
    console.log(`(基于 ${fit.nPos} 成功 / ${fit.nNeg} 失败;样本少时数字波动大,仅供趋势对照)`);
  }
  console.log(`${"─".repeat(56)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
