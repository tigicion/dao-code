#!/usr/bin/env python3
"""汇总 terminal-bench 89 题的最新 reward，统计通过/未通过。"""
import json, os, glob
from pathlib import Path
from collections import defaultdict

base = Path(__file__).parent

# 1. 加载全部 89 题
meta = json.loads((base / "task_meta.json").read_text())
all_tasks = [t["name"] for t in meta["tasks"]]
total = len(all_tasks)

# 2. 遍历所有 jobs/*/reward.txt，按 task 取最新（按目录修改时间排序）
task_results = {}  # task_name -> (reward, job_dir)

for reward_file in glob.glob(str(base / "jobs" / "*" / "*" / "verifier" / "reward.txt")):
    parts = Path(reward_file).parts
    # jobs/<job_name>/<task__id>/verifier/reward.txt
    task_dir = parts[-3]  # task__id
    job_name = parts[-4]  # job_name
    task_name = task_dir.rsplit("__", 1)[0]  # 去掉随机 ID 后缀

    try:
        reward = int(Path(reward_file).read_text().strip())
    except (ValueError, OSError):
        continue

    # 比较路径修改时间，取最新
    full_job = f"{job_name}/{task_dir}"
    job_path = base / "jobs" / job_name / task_dir
    mtime = job_path.stat().st_mtime if job_path.exists() else 0

    if task_name not in task_results or mtime > task_results[task_name][2]:
        task_results[task_name] = (reward, full_job, mtime)

# 3. 也检查 jobs 下的顶层 result.json（聚合结果），但主要看 per-task reward

# 4. 汇总
passed = []
failed = []
not_run = []

for task in sorted(all_tasks):
    if task in task_results:
        reward = task_results[task][0]
        if reward == 1:
            passed.append(task)
        else:
            failed.append(task)
    else:
        not_run.append(task)

print(f"总题数: {total}")
print(f"已通过 (reward=1): {len(passed)}")
print(f"未通过 (reward=0): {len(failed)}")
print(f"未跑过: {len(not_run)}")
print()

if failed:
    print("=== 未通过题目 ===")
    for t in failed:
        latest = task_results[t]
        print(f"  ✗ {t}  (latest: {latest[1]}, reward=0)")
    print()

if not_run:
    print("=== 从未跑过的题目 ===")
    for t in not_run:
        print(f"  ? {t}")
    print()

print(f"通过率: {len(passed)}/{total} = {len(passed)/total*100:.1f}%")
print(f"若只算跑过的: {len(passed)}/{len(passed)+len(failed)} = {len(passed)/(len(passed)+len(failed))*100:.1f}%")
