#!/usr/bin/env python3
"""从 jobs/ 和 archive/ 全部历史 trial 里按时间重建 pass rate 变化曲线。

不依赖 improvements.jsonl 也能跑(直接用 result.json 的时间戳+reward)，
如果 improvements.jsonl 存在，会在对应日期+task 命中的行上标注这次改动的一句话结论。

用法: python3 gen_timeline.py
输出: timeline.json (机读) + timeline.md (人读)
"""
import json
import glob
import os

TOTAL_TASKS = len(json.load(open("task_meta.json"))["tasks"])


def load_improvements():
    path = "improvements.jsonl"
    if not os.path.exists(path):
        return []
    out = []
    for line in open(path):
        line = line.strip()
        if line:
            out.append(json.loads(line))
    return out


def collect_events():
    events = []
    for rp in glob.glob("jobs/*/*/result.json") + glob.glob("archive/*/*/*/result.json"):
        try:
            d = json.load(open(rp))
        except Exception:
            continue
        task = (d.get("task_id") or {}).get("name")
        reward = ((d.get("verifier_result") or {}).get("rewards") or {}).get("reward")
        finished = d.get("finished_at")
        if not finished or reward is None or not task:
            continue
        events.append({"task": task, "reward": reward, "time": finished, "trial": rp})
    events.sort(key=lambda e: e["time"])
    return events


def main():
    events = collect_events()
    improvements = load_improvements()
    commit_by_date = {}
    for imp in improvements:
        commit_by_date.setdefault(imp.get("date"), []).append(imp)

    status = {}
    timeline = []
    for e in events:
        status[e["task"]] = e["reward"]
        passed = sum(1 for v in status.values() if v == 1)
        timeline.append({
            "time": e["time"],
            "task": e["task"],
            "reward": e["reward"],
            "passed_count": passed,
            "total_tasks": TOTAL_TASKS,
        })

    with open("timeline.json", "w") as f:
        json.dump(timeline, f, indent=2, ensure_ascii=False)

    with open("timeline.md", "w") as f:
        f.write("# Pass Rate 时间线\n\n")
        f.write("自动生成，来自 jobs/ + archive/ 全部历史 trial。刷新: `python3 gen_timeline.py`\n\n")
        f.write(f"当前追踪到 {len(status)} 题有过结果，通过 {sum(1 for v in status.values() if v == 1)} 题（共 {TOTAL_TASKS} 题）。\n\n")
        f.write("| 时间 | task | reward | 累计通过 | 备注 |\n|---|---|---|---|---|\n")
        for p in timeline:
            note = ""
            for imp in commit_by_date.get(p["time"][:10], []):
                if p["task"] in imp.get("tasks_affected", []):
                    note = imp.get("summary_public", "")
            f.write(f"| {p['time']} | {p['task']} | {p['reward']} | {p['passed_count']}/{p['total_tasks']} | {note} |\n")

    print(f"已写入 timeline.json / timeline.md，共 {len(timeline)} 个事件，覆盖 {len(status)} 道题")


if __name__ == "__main__":
    main()
