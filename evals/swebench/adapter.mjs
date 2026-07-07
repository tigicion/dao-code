#!/usr/bin/env node
// SWE-bench Verified 推理适配器:把 DAO 当黑盒跑一遍官方 instance,产出 predictions.jsonl。
// 不做任何判定——判定完全交给官方 swebench.harness.run_evaluation(Docker 里跑 FAIL_TO_PASS/PASS_TO_PASS)。
// DAO 源码零改动,只是复用 evals/run.mjs 同款"抛弃式临时目录 + 子进程跑 dao + 收集 diff"手法。
//
// 用法:
//   node evals/swebench/adapter.mjs [instance_id...]     # 不传 = 跑 instances.jsonl 里全部
//   EVAL_TIMEOUT_MS=600000 node evals/swebench/adapter.mjs astropy__astropy-12907
//
// 前置:evals/swebench/instances.jsonl(从 HF SWE-bench/SWE-bench_Verified 导出,字段:
//   instance_id, repo, base_commit, problem_statement)。dao 已配置 key(~/.dao/config.json)。
//
// 产出:evals/swebench/predictions.jsonl,每行 {instance_id, model_name_or_path, model_patch}。
// 接下来交给官方 harness:
//   python -m swebench.harness.run_evaluation --dataset_name SWE-bench/SWE-bench_Verified \
//     --predictions_path evals/swebench/predictions.jsonl --run_id dao-v1 --namespace ''

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const INDEX = path.join(REPO, "src", "index.ts");
const TSX = path.join(REPO, "node_modules", ".bin", "tsx");
const INSTANCES_FILE = path.join(__dirname, "instances.jsonl");
const PREDICTIONS_FILE = path.join(__dirname, "predictions.jsonl");
const RUNS_DIR = path.join(__dirname, "runs"); // 每题的 agent.log,供复盘(同 evals/run.mjs 的手法)
const TIMEOUT = Number(process.env.EVAL_TIMEOUT_MS || 600_000); // SWE-bench 真实仓库更大,默认给 10 分钟
const MODEL_NAME = "dao-" + (process.env.DAO_EVAL_TAG || "v0.3.0");

function exec(cmd, args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env } });
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (out += d.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: 127, out: String(e) }); });
  });
}

// 跑 dao(prompt → argv 一次性),自动放行审批。与 evals/run.mjs 的 runDao 同款。
function runDao({ cwd, prompt }) {
  return exec(TSX, [INDEX, prompt], { cwd, env: { DAO_AUTO_APPROVE: "1" } });
}

async function loadInstances(filter) {
  const raw = await fs.readFile(INSTANCES_FILE, "utf8");
  const all = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (!filter.length) return all;
  const byId = new Map(all.map((x) => [x.instance_id, x]));
  return filter.map((id) => byId.get(id)).filter(Boolean);
}

// 给 DAO 的任务描述:真实 issue 原文,不提测试(隐藏,防作弊——SWE-bench 范式)。
function buildPrompt(inst) {
  return `这是仓库 ${inst.repo} 里的一个真实 bug/issue。请定位并修复,只改动必要的源码(不要碰测试文件)。\n\n${inst.problem_statement}`;
}

async function runOne(inst) {
  const tmp = path.join(os.tmpdir(), `dao-swebench-${inst.instance_id}-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(tmp, { recursive: true });
  try {
    const repoUrl = `https://github.com/${inst.repo}`;
    const clone = await exec("git", ["clone", "--quiet", repoUrl, tmp]);
    if (clone.code !== 0) return { instance_id: inst.instance_id, error: `clone 失败: ${clone.out.slice(0, 300)}` };

    const co = await exec("git", ["-C", tmp, "checkout", "--quiet", inst.base_commit]);
    if (co.code !== 0) return { instance_id: inst.instance_id, error: `checkout 失败: ${co.out.slice(0, 300)}` };

    const agent = await runDao({ cwd: tmp, prompt: buildPrompt(inst) });

    // 落盘 agent 轨迹,供失败复盘(同 evals/run.mjs 的证据留存手法)。
    const dir = path.join(RUNS_DIR, inst.instance_id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "agent.log"), agent.out, "utf8");

    // 用 add -A + diff --cached:同时捕获修改/新增/删除(标准 agentic patch 生成手法,SWE-agent 同款),
    // 不局限于已跟踪文件的改动。排除 .dao/(DAO 自己的项目级状态目录——approvals/memory/audit.log 等,
    // 每次运行都会在 cwd 建;它不是任务改动,混进提交给 SWE-bench 的 patch 纯属噪声)。
    await exec("git", ["-C", tmp, "add", "-A"]);
    await exec("git", ["-C", tmp, "reset", "--", ".dao"]); // 把 .dao/ 移出暂存区(失败可忽略:目录不存在时)
    const diff = await exec("git", ["-C", tmp, "diff", "--cached"]);
    const patch = diff.out;
    await fs.writeFile(path.join(dir, "agent.diff"), patch || "(无改动)", "utf8");

    return { instance_id: inst.instance_id, model_name_or_path: MODEL_NAME, model_patch: patch };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const filter = process.argv.slice(2);
  const instances = await loadInstances(filter);
  if (!instances.length) { console.error("没有匹配的 instance。"); process.exit(1); }

  console.log(`SWE-bench 推理 —— ${instances.length} 题(模型 ${MODEL_NAME}）\n`);
  const lines = [];
  for (const inst of instances) {
    process.stdout.write(`▶ ${inst.instance_id}  `);
    const t0 = Date.now();
    const r = await runOne(inst);
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    if (r.error) {
      console.log(`⚠️  ${r.error}  (${secs}s)`);
    } else {
      const empty = !r.model_patch?.trim();
      console.log(`${empty ? "∅ 空 patch" : "✅ 有改动"}  (${secs}s)`);
      lines.push(JSON.stringify({ instance_id: r.instance_id, model_name_or_path: r.model_name_or_path, model_patch: r.model_patch }));
    }
  }
  await fs.writeFile(PREDICTIONS_FILE, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
  console.log(`\n写入 ${PREDICTIONS_FILE}(${lines.length}/${instances.length} 题产出 patch）`);
  console.log(`接下来交给官方 harness 判定:\n  python -m swebench.harness.run_evaluation --dataset_name SWE-bench/SWE-bench_Verified --predictions_path ${PREDICTIONS_FILE} --run_id dao-v1 --namespace ''`);
}

main();
