#!/usr/bin/env node
// codeds eval runner —— 对每个任务在抛弃式临时工作区里跑 codeds,做二元判定,多跑几次看 pass^k。
// 用法:DEEPSEEK_API_KEY=sk-... node evals/run.mjs [taskId...]
// 环境:EVAL_RUNS=3(每题跑几次,看 pass^k);EVAL_TIMEOUT_MS=180000
//
// 设计依据(2025-2026 评测研究):
//  - 二元 + 终态检查(Terminal-Bench 式):每题 check.mjs 对最终工作区/输出做硬判定。
//  - pass^k 优先于 pass@1(可靠性≠能力):每题跑 EVAL_RUNS 次,全过才算"稳定解决"。
//  - 用你自己的、可复现、未被公开基准污染的任务(避免 SWE-bench 的污染/过拟合问题)。

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const INDEX = path.join(REPO, "src", "index.ts");
const TSX = path.join(REPO, "node_modules", ".bin", "tsx");
const TASKS_DIR = path.join(__dirname, "tasks");
const RUNS = Number(process.env.EVAL_RUNS || 1);
const TIMEOUT = Number(process.env.EVAL_TIMEOUT_MS || 180000);

if (!process.env.DEEPSEEK_API_KEY) {
  console.error("请先设置 DEEPSEEK_API_KEY(eval 会真实调用模型、产生费用)。");
  process.exit(1);
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

function runCodeds({ cwd, prompt, input }) {
  return new Promise((resolve) => {
    const args = [INDEX];
    if (prompt) args.push(prompt);
    const child = spawn(TSX, args, {
      cwd,
      env: { ...process.env, CODEDS_AUTO_APPROVE: "1" },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT);
    if (input && input.length) child.stdin.write(input.join("\n") + "\n");
    child.stdin.end();
    const start = Date.now();
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ out, code, ms: Date.now() - start });
    });
  });
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const countToolCalls = (s) => (stripAnsi(s).match(/→ /g) || []).length;

async function loadTasks(filter) {
  const entries = await fs.readdir(TASKS_DIR, { withFileTypes: true });
  const ids = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const tasks = [];
  for (const id of ids) {
    if (filter.length && !filter.includes(id)) continue;
    const tj = JSON.parse(await fs.readFile(path.join(TASKS_DIR, id, "task.json"), "utf8"));
    tasks.push({ id, dir: path.join(TASKS_DIR, id), ...tj });
  }
  return tasks;
}

async function runOnce(task) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `codeds-eval-${task.id}-`));
  try {
    const ws = path.join(task.dir, "workspace");
    if (await exists(ws)) await fs.cp(ws, tmp, { recursive: true });
    const r = await runCodeds({ cwd: tmp, prompt: task.prompt, input: task.input });
    const check = await import(pathToFileURL(path.join(task.dir, "check.mjs")).href);
    const verdict = await check.default({
      workspace: tmp,
      output: stripAnsi(r.out),
      rawOutput: r.out,
      exitCode: r.code,
    });
    return { pass: !!verdict.pass, note: verdict.note || "", tools: countToolCalls(r.out), ms: r.ms };
  } catch (e) {
    return { pass: false, note: `runner error: ${e.message}`, tools: 0, ms: 0 };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const filter = process.argv.slice(2);
  const tasks = await loadTasks(filter);
  if (!tasks.length) {
    console.error("没有任务(检查 evals/tasks/ 或过滤参数)。");
    process.exit(1);
  }
  console.log(`codeds eval —— ${tasks.length} 个任务 × ${RUNS} 次/题\n`);
  const rows = [];
  for (const task of tasks) {
    process.stdout.write(`▶ ${task.id} (${task.desc || ""}) `);
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
      runs.push(await runOnce(task));
      process.stdout.write(runs[i].pass ? "✓" : "✗");
    }
    const solved = runs.filter((r) => r.pass).length;
    const passK = solved === RUNS; // pass^k:全过
    const avgTools = (runs.reduce((a, r) => a + r.tools, 0) / RUNS).toFixed(1);
    const avgS = (runs.reduce((a, r) => a + r.ms, 0) / RUNS / 1000).toFixed(1);
    const note = runs.find((r) => !r.pass)?.note || runs[0]?.note || "";
    rows.push({ id: task.id, solved: `${solved}/${RUNS}`, passK: passK ? "✓" : "✗", avgTools, avgS, note });
    console.log(` ${solved}/${RUNS}${note ? "  · " + note : ""}`);
  }

  console.log("\n=== 汇总 ===");
  console.log(["task", "solved", "pass^k", "工具/次", "秒/次", "备注"].join("\t"));
  for (const r of rows) {
    console.log([r.id, r.solved, r.passK, r.avgTools, r.avgS, r.note].join("\t"));
  }
  const passKCount = rows.filter((r) => r.passK === "✓").length;
  console.log(`\npass^${RUNS}: ${passKCount}/${rows.length} 个任务稳定解决`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
