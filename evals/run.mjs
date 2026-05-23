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
//  - "oss":  能力题(真实开源)。clone repo@ref(base 父 commit,bug 在、新测试缺)→ install →
//             跑前自检(临时注入 fix_ref 的测试确认 fail2pass 此刻确实失败,再撤掉)→ 跑 codeds
//             → agent 完事后才注入隐藏测试(fix_ref 的 test_files)→ fail2pass/pass2pass。
//             测试后注入、对 agent 隐藏 = 防作弊(SWE-bench/Terminal-Bench 范式)。
//             用近期(模型 cutoff 后)commit 防污染。环境较重,按需启用。
//  - "docker":同 oss,但 install/fail2pass/pass2pass 跑在容器里(重工具链 Java/C++/数据科学)。
//             codeds 本体仍在宿主跑、改挂载进容器的工作区文件(host-agent + bind-mount)。
//             测试阶段容器断网 + 降权 + 限额。task.json 多一个 "image" 字段。docker 不可用则跳过。
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
const RUNS_DIR = path.join(__dirname, "runs"); // 每次跑的轨迹/diff/测试输出落盘,供失败复盘
const RUNS = Number(process.env.EVAL_RUNS || 3);
const TIMEOUT = Number(process.env.EVAL_TIMEOUT_MS || 180000);
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-pro";

if (!process.env.DEEPSEEK_API_KEY) {
  console.error("请先设置 DEEPSEEK_API_KEY(eval 会真实调用模型、产生费用)。");
  process.exit(1);
}

// docker 是否可用(用于 kind:"docker";不可用就跳过而非崩溃)
let DOCKER_OK = null;
async function dockerAvailable() {
  if (DOCKER_OK !== null) return DOCKER_OK;
  const r = await exec("docker", ["version", "--format", "{{.Server.Version}}"], {});
  DOCKER_OK = r.code === 0;
  return DOCKER_OK;
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

// —— oss/docker 共用:健壮 clone + checkout base —————————————————————————
// SHA 可能远落后于默认分支 HEAD,不能靠 --depth 50 默认分支;
// 优先浅取指定 SHA,服务器拒绝浅取 SHA 时回退到全量 clone 再 checkout。
async function cloneAndCheckout(task, tmp) {
  await exec("git", ["clone", task.repo, tmp]);
  const refs = [task.ref, task.fix_ref].filter(Boolean);
  let shallowOk = true;
  for (const r of refs) {
    const f = await exec("git", ["-C", tmp, "fetch", "--depth", "1", "origin", r], {});
    if (f.code !== 0) { shallowOk = false; break; }
  }
  if (!shallowOk) {
    // 浅取 SHA 失败:回退全量(unshallow,若已是全量则忽略报错)
    await exec("git", ["-C", tmp, "fetch", "--unshallow"], {});
    await exec("git", ["-C", tmp, "fetch", "origin"], {});
  }
  if (task.ref) await exec("git", ["-C", tmp, "checkout", task.ref], {});
}

// 注入 fix_ref 的测试文件(把 agent 看不到的 PR 测试拉进工作区)
async function injectTests(task, tmp) {
  const files = [].concat(task.test_files || []);
  if (!files.length || !task.fix_ref) return;
  await exec("git", ["-C", tmp, "checkout", task.fix_ref, "--", ...files], {});
}

// 撤掉刚注入的测试,恢复 agent 视角(base 状态)。
// base 上可能本就没这些文件(新增测试),此时 `checkout <ref> -- <path>` 会失败,改为直接删。
async function restoreTests(task, tmp) {
  const files = [].concat(task.test_files || []);
  for (const f of files) {
    const r = await exec("git", ["-C", tmp, "checkout", task.ref, "--", f], {});
    if (r.code !== 0) {
      // base 不存在该路径:删掉以还原 agent 看不到测试的状态
      await exec("rm", ["-f", path.join(tmp, f)], {});
    }
  }
}

// 跑 oss/docker 的一条 install/test 命令:oss 直接在宿主 bash;docker 在容器里跑。
// phase: "install"(联网) | "test"(断网 + 降权 + 限额 + timeout)
function ossCmd(task, tmp, cmd, phase) {
  if (task.kind === "docker") {
    const base = ["run", "--rm", "-v", `${tmp}:/work`, "-w", "/work"];
    if (phase === "test") {
      // 隔离:断网、丢弃所有 capability、禁提权、限 CPU/内存/进程数、命令外加 timeout 兜底
      base.push("--network", "none", "--cap-drop=ALL", "--security-opt", "no-new-privileges",
        "--cpus=2", "--memory=4g", "--pids-limit=512");
      return exec("docker", [...base, task.image, "bash", "-lc", `timeout 600 ${cmd}`], {});
    }
    // install:联网开
    return exec("docker", [...base, task.image, "bash", "-lc", cmd], { });
  }
  return exec("bash", ["-lc", cmd], { cwd: tmp });
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
  if (task.kind === "oss" || task.kind === "docker") {
    // a. 健壮 clone base 父 commit(bug 在、新测试缺)
    await cloneAndCheckout(task, tmp);
    // b. install(oss 在宿主、docker 在容器,均联网)
    if (task.install) {
      for (const c of [].concat(task.install)) {
        await ossCmd(task, tmp, c, "install");
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
  // double / oss / docker:双轨。缺验证器直接判失败(防"空双轨默默判过"的假阳性)。
  const isOss = task.kind === "oss" || task.kind === "docker";
  if (!task.fail2pass && !task.pass2pass) {
    return { pass: false, note: "验证器缺失(double/oss/docker 任务必须配 fail2pass/pass2pass)" };
  }
  const f2p = task.fail2pass
    ? isOss
      ? await ossCmd(task, tmp, task.fail2pass, "test")
      : await runTest(task.dir, task.fail2pass, tmp)
    : { pass: true };
  const p2p = task.pass2pass
    ? isOss
      ? await ossCmd(task, tmp, task.pass2pass, "test")
      : await runTest(task.dir, task.pass2pass, tmp)
    : { pass: true };
  const f2pPass = isOss ? f2p.code === 0 : f2p.pass;
  const p2pPass = isOss ? p2p.code === 0 : p2p.pass;
  const pass = f2pPass && p2pPass;
  const note = pass ? "" : !f2pPass ? "fail2pass 未通过(没真正解决)" : "pass2pass 未通过(改坏了既有功能)";
  // 把两轨原始输出带出去落盘(看哪个 subtest 怎么挂的)
  return { pass, note, f2pOut: f2p.out ?? "", p2pOut: p2p.out ?? "" };
}

// 捕获 agent 实际改了什么(在注入隐藏测试之前调,diff 才干净):
//  oss/docker → git diff 工作区;double/local → 与起始 workspace 做递归 diff。
async function captureDiff(task, tmp) {
  if (task.kind === "oss" || task.kind === "docker") {
    const r = await exec("git", ["-C", tmp, "diff"], {});
    return r.out;
  }
  const ws = path.join(task.dir, "workspace");
  if (await exists(ws)) {
    const r = await exec("diff", ["-ru", ws, tmp], {});
    return r.out;
  }
  return "";
}

// 落盘一次运行的全部证据:轨迹 / diff / 两轨测试输出 / 元信息。
async function persistRun(task, i, { agentOut, diff, v, tools, ms }) {
  const dir = path.join(RUNS_DIR, task.id, `run-${i + 1}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "agent.log"), stripAnsi(agentOut || ""), "utf8");
  await fs.writeFile(path.join(dir, "agent.diff"), diff || "(无改动)", "utf8");
  if (v.f2pOut != null) await fs.writeFile(path.join(dir, "fail2pass.log"), v.f2pOut, "utf8");
  if (v.p2pOut != null) await fs.writeFile(path.join(dir, "pass2pass.log"), v.p2pOut, "utf8");
  await fs.writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify({ id: task.id, kind: task.kind, run: i + 1, pass: v.pass, note: v.note, tools, ms }, null, 2),
    "utf8",
  );
}

async function runOnce(task, i = 0) {
  // docker 任务:宿主无 docker 就跳过(而非崩溃)
  if (task.kind === "docker" && !(await dockerAvailable())) {
    return { pass: false, note: "docker 不可用,跳过", tools: 0, ms: 0, skip: true };
  }
  const tmp = await prepareWorkspace(task);
  try {
    const isOss = task.kind === "oss" || task.kind === "docker";
    // double:跑前确认 base 确实让 fail2pass 失败(任务有效性自检)
    if (task.kind === "double" && task.fail2pass) {
      const base = await runTest(task.dir, task.fail2pass, tmp);
      if (base.pass) return { pass: false, note: "⚠️任务无效:base 未改时 fail2pass 就已通过", tools: 0, ms: 0 };
    }
    // c. oss/docker:跑前临时注入 PR 测试,验 fail2pass 此刻确实失败(bug 在),再撤掉(对 agent 隐藏)
    if (isOss && task.fail2pass) {
      await injectTests(task, tmp);
      const base = await ossCmd(task, tmp, task.fail2pass, "test");
      await restoreTests(task, tmp);
      // 127/126 = 命令无法执行(缺命令/解释器),不是"测试因 bug 失败"。
      // 必须和"bug 在(exit 1)"区分,否则环境坏了也被当成有效任务、最终误报成"没真正解决"。
      if (base.code === 126 || base.code === 127) {
        return { pass: false, note: `⚠️环境问题:fail2pass 命令无法执行(exit ${base.code},疑似缺命令/解释器,非 agent 失败)`, tools: 0, ms: 0 };
      }
      if (base.code === 0) return { pass: false, note: "⚠️任务无效:base 未改时 fail2pass 就已通过", tools: 0, ms: 0 };
    }
    // d. 在 base 工作区(bug 在、测试缺)跑 codeds
    const r = await runCodeds({ cwd: tmp, prompt: task.prompt, input: task.input });
    // d'. 注入测试前先抓 agent 的改动(此刻 diff 只含 agent 改的源码,不含隐藏测试)
    const diff = await captureDiff(task, tmp);
    // e. agent 完事后才注入真测试(已无法看到)
    if (isOss) await injectTests(task, tmp);
    const v = await judge(task, tmp, r.out, r.code);
    const tools = countTools(r.out);
    await persistRun(task, i, { agentOut: r.out, diff, v, tools, ms: r.ms ?? 0 });
    return { pass: v.pass, note: v.note, tools, ms: r.ms ?? 0, codedsMs: r.ms };
  } catch (e) {
    return { pass: false, note: `runner error: ${e.message}`, tools: 0, ms: 0 };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

const KIND_LABEL = { double: "能力·双轨", oss: "能力·OSS", docker: "能力·容器", local: "安全/红队" };

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
    await fs.rm(path.join(RUNS_DIR, task.id), { recursive: true, force: true }); // 清掉上次本题的轨迹
    for (let i = 0; i < RUNS; i++) {
      const r = await runOnce(task, i);
      runs.push(r);
      process.stdout.write(r.skip ? "⏭️" : r.pass ? "✅" : "❌");
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
