#!/usr/bin/env node
// 把 materializeTrace 产出的 trace 目录(state.json + turns.jsonl)渲染成一份自包含的
// HTML 摘要——按轮展开思维链/工具调用/结果,配缓存命中率图表。双击/浏览器直接打开,不用发布 Artifact。
//
// 用法:
//   node evals/render-trace.mjs evals/runs/02-dedupe/run-1
//     → 读同目录的 meta.json 拿 pass/fail,渲染 evals/runs/02-dedupe/run-1/trace/trace.html
//   node evals/render-trace.mjs evals/runs/02-dedupe/run-1/trace
//     → 直接给 trace 目录也行(不带 meta.json 时 pass 显示"判定见外部 harness")
//   node evals/render-trace.mjs .dao/sessions/<id>
//     → dogfooding 会话不是 eval run,先手动跑一次
//     `node -e "import('./evals/materialize-trace.mjs').then(m=>m.materializeTrace('.dao/sessions/<id>'))"`
//     物化出 turns.jsonl 再指这个目录

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, "trace-viewer-template.html");

async function readJsonSafe(p) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; }
}

// 判断给的路径本身就是 trace 目录(有 state.json),还是 run 目录(trace 在它的 trace/ 子目录下)。
async function resolveTraceDir(input) {
  if (await fs.access(path.join(input, "state.json")).then(() => true).catch(() => false)) return input;
  const nested = path.join(input, "trace");
  if (await fs.access(path.join(nested, "state.json")).then(() => true).catch(() => false)) return nested;
  throw new Error(`在 ${input} 或 ${nested} 都没找到 state.json——先跑 materializeTrace 物化出 turns.jsonl`);
}

export async function renderTraceHtml(traceDir, { pass, taskId, sourceHint } = {}) {
  const state = await readJsonSafe(path.join(traceDir, "state.json"));
  if (!state) throw new Error(`${traceDir}/state.json 缺失或不是合法 JSON`);
  const turnsRaw = (await fs.readFile(path.join(traceDir, "turns.jsonl"), "utf8").catch(() => ""))
    .trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (!turnsRaw.length) throw new Error(`${traceDir}/turns.jsonl 缺失或为空——先用 materializeTrace 物化`);

  const idToResult = new Map();
  for (const m of state.messages) if (m.role === "tool") idToResult.set(m.tool_call_id, m.content);

  const turns = turnsRaw.map((t) => {
    const am = state.messages[t.msgIndex] || {};
    return {
      turn: t.turn,
      text: am.content ?? null,
      reasoning: am.reasoningContent || null,
      cache: t.cache || null,
      toolCalls: (t.toolCalls || []).map((c) => ({
        name: c.name,
        args: (am.tool_calls || []).find((x) => x.id === c.id)?.function?.arguments,
        ok: c.ok,
        result: idToResult.get(c.id),
      })),
    };
  });

  const data = {
    taskId: taskId || state.id,
    pass: pass ?? null,
    model: state.model,
    mode: state.mode,
    sessionId: state.id,
    usage: state.usage,
    sourceHint: sourceHint || traceDir,
    turns,
  };

  const template = await fs.readFile(TEMPLATE_PATH, "utf8");
  const json = JSON.stringify(data).replace(/</g, "\\u003c"); // 防 </script> 提前截断内联 JSON
  return template.replace("__TRACE_DATA__", json);
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error("用法: node evals/render-trace.mjs <run 目录 或 trace 目录>");
    process.exit(1);
  }
  const traceDir = await resolveTraceDir(path.resolve(input));
  // run 目录下的 meta.json(eval 跑分产出的 pass/fail ground truth);trace 目录本身没有就不强求。
  const runDir = path.basename(traceDir) === "trace" ? path.dirname(traceDir) : traceDir;
  const meta = await readJsonSafe(path.join(runDir, "meta.json"));
  const html = await renderTraceHtml(traceDir, {
    pass: meta?.pass,
    taskId: meta?.id,
    sourceHint: path.relative(process.cwd(), traceDir),
  });
  const outPath = path.join(traceDir, "trace.html");
  await fs.writeFile(outPath, html, "utf8");
  console.log(`已生成 ${outPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message); process.exit(1); });
