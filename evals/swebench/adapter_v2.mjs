#!/usr/bin/env node
// SWE-bench 推理适配器 v2 —— "容器进驻"版:DAO 本身在官方 harness 建的精确环境容器里干活
// (和判定阶段同一套镜像),而不是在宿主机瞎凑合。零 DAO 源码改动——把 DAO 编译成 linux-x64
// 二进制,docker cp 进容器,docker exec 直接跑;所有工具调用(read/write/exec_shell)天然
// 作用于容器文件系统/环境(真实依赖、真实 Python 版本),不是宿主机的错配环境。
//
// 用法:node evals/swebench/adapter_v2.mjs [instance_id...]
// 前置:
//   - evals/swebench/container_helper.py 能跑(harness venv 已装好 swebench 包)
//   - Docker 可用;串行跑(一次一个 instance,规避并发建重镜像时的内存竞争,已实测验证)
//   - .env 里有 DS_API_KEY
//
// 产出:evals/swebench/predictions_v2.jsonl,交给官方 harness 判定(镜像已建好,判定阶段直接复用):
//   python -m swebench.harness.run_evaluation --dataset_name SWE-bench/SWE-bench_Verified \
//     --predictions_path evals/swebench/predictions_v2.jsonl --run_id dao-v2 --namespace ''

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { materializeTrace } from "../materialize-trace.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const HARNESS_DIR = process.env.SWEBENCH_HARNESS_DIR; // 见下方校验:必须显式指定 harness venv 所在目录
const PYTHON = HARNESS_DIR ? path.join(HARNESS_DIR, ".venv", "bin", "python3") : null;
const HELPER = path.join(__dirname, "container_helper.py");
const BIN = path.join(__dirname, "dao-linux-x64");
const PREDICTIONS_FILE = path.join(__dirname, "predictions_v2.jsonl");
const RUNS_DIR = path.join(__dirname, "runs");
const TIMEOUT = Number(process.env.EVAL_TIMEOUT_MS || 900_000);
const MODEL_NAME = "dao-container-" + (process.env.DAO_EVAL_TAG || "v0.3.0");
const RUN_ID = "dao-v2";

function exec(cmd, args, { timeout = TIMEOUT, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, cwd ? { cwd } : {});
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (out += d.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: 127, out: String(e) }); });
  });
}

async function readEnvKey() {
  const raw = await fs.readFile(path.join(REPO, ".env"), "utf8").catch(() => "");
  const m = raw.match(/^DS_API_KEY=(.+)$/m);
  if (!m) throw new Error(".env 里没找到 DS_API_KEY");
  return m[1].trim();
}

async function loadInstances(filter) {
  const raw = await fs.readFile(path.join(__dirname, "instances.jsonl"), "utf8");
  const all = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (!filter.length) return all;
  const byId = new Map(all.map((x) => [x.instance_id, x]));
  return filter.map((id) => byId.get(id)).filter(Boolean);
}

function buildPrompt(inst) {
  return `这是仓库 ${inst.repo} 里的一个真实 bug/issue。请定位并修复,只改动必要的源码(不要碰测试文件)。\n\n${inst.problem_statement}`;
}

// 建容器(调用 Python 助手,复用官方 build_env_images/build_container)
async function startContainer(instanceId) {
  // cwd 固定到 harness 目录:它内部用相对路径写 build 日志(logs/build_images/...),
  // 不设 cwd 会散落进 Node 进程的 cwd(之前误落进了 DAO 仓库目录)。
  const r = await exec(PYTHON, [HELPER, instanceId, RUN_ID], { timeout: TIMEOUT, cwd: HARNESS_DIR });
  const dir = path.join(RUNS_DIR, instanceId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "container_helper.log"), r.out, "utf8"); // 完整输出落盘,不再靠截断诊断
  const lastLine = r.out.trim().split("\n").filter(Boolean).pop() || "";
  let parsed;
  try { parsed = JSON.parse(lastLine); } catch { throw new Error(`建容器失败,完整日志见 ${dir}/container_helper.log`); }
  if (parsed.error) throw new Error(parsed.error);
  return parsed; // { container, workdir }
}

async function runOne(inst, apiKey) {
  const dir = path.join(RUNS_DIR, inst.instance_id);
  await fs.mkdir(dir, { recursive: true });

  const { container, workdir } = await startContainer(inst.instance_id);
  try {
    const cp = await exec("docker", ["cp", BIN, `${container}:/dao`]);
    if (cp.code !== 0) return { instance_id: inst.instance_id, error: `docker cp 失败: ${cp.out.slice(0, 300)}` };
    await exec("docker", ["exec", container, "chmod", "+x", "/dao"]);

    const agent = await exec("docker", [
      "exec", "-e", "DAO_AUTO_APPROVE=1", "-w", workdir, container,
      "/dao", "-p", buildPrompt(inst), "--api-key", apiKey, "--provider", "deepseek",
    ]);
    await fs.writeFile(path.join(dir, "agent.log"), agent.out, "utf8");

    // 排除 .dao/(DAO 自己的项目级状态目录),同 adapter.mjs 的手法。
    await exec("docker", ["exec", "-w", workdir, container, "git", "add", "-A"]);
    await exec("docker", ["exec", "-w", workdir, container, "git", "reset", "--", ".dao"]);
    const diff = await exec("docker", ["exec", "-w", workdir, container, "git", "diff", "--cached"]);
    const patch = diff.out;
    await fs.writeFile(path.join(dir, "agent.diff"), patch || "(无改动)", "utf8");

    // 完整结构化 trace:容器里的 .dao/sessions/ 先 docker cp 到宿主临时目录,再物化 + 归档,
    // 容器删掉前必须做完(finally 里就 docker rm 了)。
    const localCopy = path.join(os.tmpdir(), `dao-swebench-v2-sessions-${inst.instance_id}-${Math.random().toString(36).slice(2, 8)}`);
    try {
      const cpR = await exec("docker", ["cp", `${container}:${workdir}/.dao/sessions`, localCopy]);
      // docker cp 的目标若不存在会新建同名目录并把 .dao/sessions/ 的内容拷进去,故 localCopy 本身就是那层目录
      // (一次容器只跑一次 dao,理论上只有一个 session 子目录,但仍按目录逐个物化,不假设数量)。
      if (cpR.code === 0) {
        const names = await fs.readdir(localCopy).catch(() => []);
        for (const n of names) {
          const sd = path.join(localCopy, n);
          await materializeTrace(sd);
          await fs.cp(sd, path.join(dir, "trace"), { recursive: true });
        }
      }
    } catch (e) {
      console.error(`[trace] ${inst.instance_id} 落盘失败(不影响 patch 产出): ${e.message}`);
    } finally {
      await fs.rm(localCopy, { recursive: true, force: true }).catch(() => {});
    }

    return { instance_id: inst.instance_id, model_name_or_path: MODEL_NAME, model_patch: patch };
  } finally {
    await exec("docker", ["rm", "-f", container]);
  }
}

async function main() {
  if (!HARNESS_DIR) {
    console.error("请设置 SWEBENCH_HARNESS_DIR 指向装好 swebench 包的 harness 目录(含 .venv/)");
    process.exit(1);
  }
  const filter = process.argv.slice(2);
  const instances = await loadInstances(filter);
  if (!instances.length) { console.error("没有匹配的 instance。"); process.exit(1); }
  const apiKey = await readEnvKey();

  console.log(`SWE-bench 推理 v2(容器进驻)—— ${instances.length} 题(模型 ${MODEL_NAME}）\n`);
  const lines = [];
  for (const inst of instances) {
    process.stdout.write(`▶ ${inst.instance_id}  `);
    const t0 = Date.now();
    let r;
    try {
      r = await runOne(inst, apiKey);
    } catch (e) {
      r = { instance_id: inst.instance_id, error: String(e.message || e) };
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    if (r.error) {
      console.log(`⚠️  ${r.error.slice(0, 200)}  (${secs}s)`);
    } else {
      const empty = !r.model_patch?.trim();
      console.log(`${empty ? "∅ 空 patch" : "✅ 有改动"}  (${secs}s)`);
      lines.push(JSON.stringify({ instance_id: r.instance_id, model_name_or_path: r.model_name_or_path, model_patch: r.model_patch }));
    }
  }
  await fs.writeFile(PREDICTIONS_FILE, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
  console.log(`\n写入 ${PREDICTIONS_FILE}(${lines.length}/${instances.length} 题产出 patch）`);
  console.log(`接下来交给官方 harness 判定:\n  python -m swebench.harness.run_evaluation --dataset_name SWE-bench/SWE-bench_Verified --predictions_path ${PREDICTIONS_FILE} --run_id dao-v2 --namespace ''`);
}

main();
