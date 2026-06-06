#!/usr/bin/env node
// codeds eval runner v2
// 对每个任务,在抛弃式临时工作区里跑 codeds,做"双轨 + 终态"硬判定,多跑几次看 pass^k,
// 末尾打印可读汇总并写 evals/report.md。
//
// 用法:DEEPSEEK_API_KEY=sk-... node evals/run.mjs [taskId...]
// 环境:EVAL_RUNS(每题跑几次,默认 3,看 pass^k);EVAL_TIMEOUT_MS(默认 180000)
//
// 任务类型(task.json 的 "kind"):
//  - "double":能力题。workspace/ 拷进 agent 工作区(buggy 代码);测试文件放 tests/(对 agent 隐藏,
//             防作弊)。fail2pass:agent 改完应由失败转通过;pass2pass:既有功能须始终通过。
//             跑前先验 base 确实让 fail2pass 失败(确认任务有效)。
//  - "oss":  能力题(真实开源)。clone repo@ref → install → 跑 codeds → fail2pass/pass2pass。
//             用近期(模型 cutoff 后)commit 防污染。环境较重,按需启用。
//  - "local":安全/红队题。workspace/(可选)+ check.mjs 做确定性判定。
//
// 设计依据(2025-26 评测研究):真实取材;fail2pass+pass2pass 双轨(SWE-bench);隐藏测试防 gaming
// (ImpossibleBench);pass^k 看可靠性而非能力;去污染靠近期任务。

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
const RUNS = Number(process.env.EVAL_RUNS || 3);
const TIMEOUT = Number(process.env.EVAL_TIMEOUT_MS || 180000);
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-pro";

if (!process.env.DEEPSEEK_API_KEY) {
  console.error("请先设置 DEEPSEEK_API_KEY(eval 会真实调用模型、产生费用)。");
  process.exit(1);
}

const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const countTools = (s) => (stripAnsi(s).match(/→ /g) || []).length;

// 跑一个子进程,返回 {code, out}
function exec(cmd, args, { cwd, input, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env } });
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (out += d.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT);
    if (input) child.stdin.write(input);
    child.stdin?.end();
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: 127, out: String(e) }); });
  });
}

// 跑 codeds(prompt → argv 一次性;input → REPL 管道),自动放行审批。
function runCodeds({ cwd, prompt, input }) {
  const args = [INDEX];
  if (prompt) args.push(prompt);
  return exec(TSX, args, {
    cwd,
    input: input ? input.join("\n") + "\n" : undefined,
    env: { CODEDS_AUTO_APPROVE: "1" },
  });
}

// 双轨测试:node <taskdir>/<testRel> <workspace> —— 退出码 0 = 通过。
async function runTest(taskDir, testRel, workspace) {
  const r = await exec(process.execPath, [path.join(taskDir, testRel), workspace], {});
  return { pass: r.code === 0, out: r.out };
}

async function loadTasks(filter) {
  const entries = await fs.readdir(TASKS_DIR, { withFileTypes: true });
  const ids = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const tasks = [];
  for (const id of ids) {
    if (filter.length && !filter.includes(id)) continue;
    const tjPath = path.join(TASKS_DIR, id, "task.json");
    if (!(await exists(tjPath))) continue; // 跳过模板等无 task.json 的目录
    const tj = JSON.parse(await fs.readFile(tjPath, "utf8"));
    tasks.push({ id, dir: path.join(TASKS_DIR, id), kind: "local", ...tj });
  }
  return tasks;
}

// 准备 agent 工作区(返回 tmp 目录)
async function prepareWorkspace(task) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `codeds-eval-${task.id}-`));
  if (task.kind === "oss") {
    await exec("git", ["clone", "--depth", "50", task.repo, tmp]);
    if (task.ref) await exec("git", ["-C", tmp, "checkout", task.ref]);
    if (task.install) {
      for (const c of [].concat(task.install)) {
        const [bin, ...a] = c.split(" ");
        await exec(bin, a, { cwd: tmp });
      }
    }
  } else {
    const ws = path.join(task.dir, "workspace");
    if (await exists(ws)) await fs.cp(ws, tmp, { recursive: true });
  }
  return tmp;
}

async function judge(task, tmp, codedsOut, exitCode) {
  if (task.kind === "local") {
    const check = await import(pathToFileURL(path.join(task.dir, "check.mjs")).href);
    const v = await check.default({ workspace: tmp, output: stripAnsi(codedsOut), exitCode });
    return { pass: !!v.pass, note: v.note || "" };
  }
  // double / oss:双轨。缺验证器直接判失败(防"空双轨默默判过"的假阳性)。
  if (!task.fail2pass && !task.pass2pass) {
    return { pass: false, note: "验证器缺失(double/oss 任务必须配 fail2pass/pass2pass)" };
  }
  const f2p = task.fail2pass
    ? task.kind === "oss"
      ? await exec("bash", ["-lc", task.fail2pass], { cwd: tmp })
      : await runTest(task.dir, task.fail2pass, tmp)
    : { pass: true };
  const p2p = task.pass2pass
    ? task.kind === "oss"
      ? await exec("bash", ["-lc", task.pass2pass], { cwd: tmp })
      : await runTest(task.dir, task.pass2pass, tmp)
    : { pass: true };
  const f2pPass = task.kind === "oss" ? f2p.code === 0 : f2p.pass;
  const p2pPass = task.kind === "oss" ? p2p.code === 0 : p2p.pass;
  const pass = f2pPass && p2pPass;
  const note = pass ? "" : !f2pPass ? "fail2pass 未通过(没真正解决)" : "pass2pass 未通过(改坏了既有功能)";
  return { pass, note };
}

async function runOnce(task) {
  const tmp = await prepareWorkspace(task);
  try {
    // double:跑前确认 base 确实让 fail2pass 失败(任务有效性自检)
    if (task.kind === "double" && task.fail2pass) {
      const base = await runTest(task.dir, task.fail2pass, tmp);
      if (base.pass) return { pass: false, note: "⚠️任务无效:base 未改时 fail2pass 就已通过", tools: 0, ms: 0 };
    }
    const r = await runCodeds({ cwd: tmp, prompt: task.prompt, input: task.input });
    const v = await judge(task, tmp, r.out, r.code);
    return { pass: v.pass, note: v.note, tools: countTools(r.out), ms: r.ms ?? 0, codedsMs: r.ms };
  } catch (e) {
    return { pass: false, note: `runner error: ${e.message}`, tools: 0, ms: 0 };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

const KIND_LABEL = { double: "能力·双轨", oss: "能力·OSS", local: "安全/红队" };

async function main() {
  const filter = process.argv.slice(2);
  const tasks = await loadTasks(filter);
  if (!tasks.length) { console.error("没有任务。"); process.exit(1); }

  console.log(`codeds eval —— ${tasks.length} 题 × ${RUNS} 次  (模型 ${MODEL})\n`);
  const rows = [];
  for (const task of tasks) {
    process.stdout.write(`▶ ${task.id}  `);
    const runs = [];
    const t0 = Date.now();
    for (let i = 0; i < RUNS; i++) {
      const r = await runOnce(task);
      runs.push(r);
      process.stdout.write(r.pass ? "✅" : "❌");
    }
    const solved = runs.filter((r) => r.pass).length;
    const passK = solved === RUNS;
    const avgTools = (runs.reduce((a, r) => a + r.tools, 0) / RUNS).toFixed(1);
    const avgS = ((Date.now() - t0) / RUNS / 1000).toFixed(0);
    const note = runs.find((r) => !r.pass)?.note || "";
    rows.push({ id: task.id, kind: KIND_LABEL[task.kind] || task.kind, desc: task.desc || "", solved: `${solved}/${RUNS}`, passK, avgTools, avgS, note });
    console.log(`  ${solved}/${RUNS}${note ? "  · " + note : ""}`);
  }

  // ---- 可读报告 ----
  const stableK = rows.filter((r) => r.passK).length;
  const everSolved = rows.filter((r) => r.solved !== `0/${RUNS}`).length;
  const headline = `稳定解决(pass^${RUNS}):${stableK}/${rows.length}    至少解决一次:${everSolved}/${rows.length}`;

  const md = [
    `# codeds eval 报告`,
    ``,
    `- 模型:\`${MODEL}\`    每题跑:${RUNS} 次`,
    `- **${headline}**`,
    ``,
    `| 任务 | 类型 | pass^${RUNS} | 通过 | 工具/次 | 秒/次 | 失败原因 |`,
    `|---|---|:---:|:---:|---:|---:|---|`,
    ...rows.map((r) => `| ${r.id} | ${r.kind} | ${r.passK ? "✅" : "❌"} | ${r.solved} | ${r.avgTools} | ${r.avgS} | ${r.note} |`),
    ``,
    `> pass^${RUNS} = 连续 ${RUNS} 次全过(可靠);只过几次说明不稳定。`,
    `> "能力·双轨/OSS" = fail2pass(真解决)+ pass2pass(没改坏)双轨判定;"安全/红队" = 行为/状态硬判定。`,
    `> 详见 evals/README.md。`,
    ``,
  ].join("\n");
  await fs.writeFile(path.join(__dirname, "report.md"), md, "utf8");

  console.log(`\n${"─".repeat(60)}`);
  console.log(headline);
  console.log(`${"─".repeat(60)}`);
  const pad = (s, n) => String(s) + " ".repeat(Math.max(0, n - String(s).length));
  console.log(pad("任务", 24) + pad("类型", 12) + pad(`pass^${RUNS}`, 8) + pad("通过", 7) + "失败原因");
  for (const r of rows) {
    console.log(pad(r.id, 24) + pad(r.kind, 12) + pad(r.passK ? "✅" : "❌", 8) + pad(r.solved, 7) + r.note);
  }
  console.log(`\n报告已写入 evals/report.md`);
}

main().catch((e) => { console.error(e); process.exit(1); });
