#!/usr/bin/env python3
"""从 jobs/ 和 archive/ 目录收集每道题的最新有效结果，输出 results.json 供汇总表使用。

对每个 task 取最新一次有 reward 的 trial（没有 reward 的取最新一次）作为主记录，
同时扫全部历史 trial 算出该题是否曾经通过过一次（ever_passed），支持两种通过口径：
"按最新"（当前这版代码/prompt 是否还能稳定过）和"按曾通过一次"（能力上限是否已证明达到）。
两者可能不同——同一题多次迭代下，最新一次未必等于历史最好成绩（比如撞上非确定性抖动、
或后续改动引入了真回归）。

提取：时间、provider、model、reward、exception 类型、工具调用数、token 统计、
运行命令、trial 目录路径、任务元信息（难度/类别/超时/内存）。

用法: python3 collect_results.py [--verbose]
输出: results.json
"""
import json, os, glob, re, sys
from datetime import datetime

META = json.load(open("task_meta.json"))
META_BY_NAME = {t["name"]: t for t in META["tasks"]}
SPLIT = json.load(open("split.json"))
HELD_OUT = set(SPLIT["held_out"])

def extract_from_trial(job_dir, trial_dir):
    """从一个 trial 目录提取所有可用的运行信息。"""
    trial = os.path.basename(trial_dir.rstrip("/"))
    task = trial.split("__")[0] if "__" in trial else trial

    # reward
    reward = None
    rp = trial_dir + "verifier/reward.txt"
    if os.path.exists(rp):
        try: reward = int(open(rp).read().strip())
        except: reward = open(rp).read().strip()

    # exception
    exc_type = None
    ep = trial_dir + "exception.txt"
    if os.path.exists(ep):
        et = open(ep).read()
        if "_handle_sigterm" in et: exc_type = "Timeout(External)"
        elif "AgentTimeoutError" in et: exc_type = "Timeout"
        elif "CancelledError" in et: exc_type = "Cancelled"
        elif "NonZeroAgentExitCode" in et: exc_type = "NonZeroExit"
        else: exc_type = "Other"

    # config.json -> provider/model
    config = {}
    cpath = job_dir + "config.json"
    if os.path.exists(cpath):
        try: config = json.load(open(cpath))
        except: pass
    agents = config.get("agents", [])
    provider = agents[0].get("kwargs", {}).get("provider", "deepseek") if agents else "deepseek"
    model = agents[0].get("kwargs", {}).get("model", "") if agents else ""
    if not model: model = "deepseek-v4-pro"  # DAO 默认模型
    atm = config.get("agent_timeout_multiplier", 1.0)

    # trial.log -> dao 运行命令
    run_cmd = ""
    tlog = trial_dir + "trial.log"
    if os.path.exists(tlog):
        for line in open(tlog):
            if "/usr/local/bin/dao" in line and "Running command:" in line:
                run_cmd = line.strip()
                break

    # tool-trace.jsonl -> 工具调用数
    tool_calls = 0
    trace_files = glob.glob(trial_dir + "/agent/dao_snapshot/.dao/sessions/*/tool-trace.jsonl")
    if trace_files:
        try:
            for line in open(trace_files[0]):
                d = json.loads(line)
                if d.get("kind") == "call":
                    tool_calls += 1
        except: pass

    # cache.jsonl -> token 统计
    tokens_in = tokens_cache = tokens_out = 0
    turns = 0
    cache_files = glob.glob(trial_dir + "/agent/dao_snapshot/.dao/sessions/*/cache.jsonl")
    if cache_files:
        try:
            for line in open(cache_files[0]):
                d = json.loads(line)
                tokens_in += d.get("prompt", 0)
                tokens_cache += d.get("hit", 0)
                tokens_out += d.get("completion", 0)
                turns = max(turns, d.get("turn", 0) + 1)
        except: pass

    # result.json -> cost
    cost = None
    rpath = job_dir + "result.json"
    if os.path.exists(rpath):
        try:
            r = json.load(open(rpath))
            cost = r.get("stats", {}).get("cost_usd")
        except: pass

    # task meta
    tm = META_BY_NAME.get(task, {})

    return {
        "task": task,
        "reward": reward,
        "exc_type": exc_type,
        "time": datetime.fromtimestamp(os.path.getmtime(job_dir)).strftime("%Y-%m-%d %H:%M"),
        "jobname": os.path.basename(job_dir.rstrip("/")),
        "trial_id": trial,
        "trial_dir": trial_dir.rstrip("/"),
        "provider": provider,
        "model": model,
        "atm": atm,
        "tool_calls": tool_calls,
        "turns": turns,
        "tokens_in": tokens_in if tokens_in else None,
        "tokens_cache": tokens_cache if tokens_cache else None,
        "tokens_out": tokens_out if tokens_out else None,
        "cost_usd": cost,
        "timeout_sec": tm.get("agent_timeout_sec", 900),
        "memory_mb": tm.get("memory_mb", 2048),
        "difficulty": tm.get("difficulty", "?"),
        "category": tm.get("category", "?"),
        "is_heldout": task in HELD_OUT,
        "run_cmd": run_cmd[-300:] if run_cmd else "",
    }

def main():
    all_trials = []
    # jobs/<task>/<job>/ 是活跃迭代目录(按题分文件夹，2026-07-23起)；
    # archive/<批次>/<job>/ 是归档批次，job目录下都挂trial目录，形状一致
    job_dirs = glob.glob("jobs/*/*/") + glob.glob("archive/*/*/")
    for d in sorted(job_dirs):
        for sub in glob.glob(d + "*/"):
            if "__" not in os.path.basename(sub.rstrip("/")): continue
            try:
                info = extract_from_trial(d, sub)
                all_trials.append(info)
            except Exception as e:
                print(f"WARNING: skip {sub}: {e}", file=sys.stderr)

    # 每个 task 取最新的有 reward 的（"按最新"口径的主记录）
    by_task = {}
    for r in all_trials:
        t = r["task"]
        if t not in by_task:
            by_task[t] = r
        elif r["reward"] is not None and (by_task[t]["reward"] is None or r["time"] > by_task[t]["time"]):
            by_task[t] = r

    # 每个 task 是否曾经通过过一次（"按曾通过一次"口径），记第一次通过的时间/job 溯源
    first_pass = {}
    for r in sorted(all_trials, key=lambda x: x["time"]):
        t = r["task"]
        if r["reward"] == 1 and t not in first_pass:
            first_pass[t] = {"time": r["time"], "jobname": r["jobname"], "trial_id": r["trial_id"]}

    for t, r in by_task.items():
        fp = first_pass.get(t)
        r["ever_passed"] = fp is not None
        r["first_pass_time"] = fp["time"] if fp else None
        r["first_pass_jobname"] = fp["jobname"] if fp else None

    results = sorted(by_task.values(), key=lambda x: x["task"])
    with open("results.json", "w") as f:
        json.dump(results, f, indent=2, ensure_ascii=False, default=str)

    passed = [r for r in results if r["reward"] == 1]
    failed = [r for r in results if r["reward"] == 0]
    no_result = [r for r in results if r["reward"] is None]
    ever_passed = [r for r in results if r["ever_passed"]]

    print(f"总计: {len(results)} 题 | 按最新-通过: {len(passed)} | 按最新-未通过: {len(failed)} | 无结果: {len(no_result)}")
    print(f"按曾通过一次-通过: {len(ever_passed)} | 未通过: {len(results) - len(ever_passed)}")
    print(f"已写入 results.json")

    if "--verbose" in sys.argv:
        print(f"\n=== 未通过 ({len(failed)}) ===")
        for r in failed:
            print(f"  {r['task']:40s} {r['time']} {r['jobname']:35s} {r['provider']:10s} exc={r['exc_type']} turns={r['turns']} tools={r['tool_calls']} tok_in={r['tokens_in']} tok_out={r['tokens_out']}")

if __name__ == "__main__":
    main()
