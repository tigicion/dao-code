#!/usr/bin/env python3
"""按题聚合当前迭代进度，输出 jobs/TASK_STATUS.md：每题当前状态(通过/待迭代/未开始/异常/
已放弃)、最新job、尝试次数、最近活动时间，供下一轮迭代直接从这张表挑题，不用逐个翻job
目录核对。

状态默认只反映客观数据(有没有跑过、reward是多少、有没有异常)。"是否已判定真实难度、
不用再投入"这类主观决定不自动推断——evolution-log.md 里同一道题的"真实难度"判断经常被
后续复核推翻(比如 chess-best-move 曾被标真实难度后又改判)，这类判断默认只在备注列给个
线索(日志提及次数)，不代替人工下结论。

真要下这个结论(标"已放弃"或"低优先级")，人工编辑 task_overrides.json 显式记录，
不靠脚本猜：
```json
{"task名": {"tag": "abandoned", "reason": "..."}}       // 不再迭代,沉到已通过之上、其它待迭代之下
{"task名": {"tag": "low_priority", "reason": "..."}}    // 仍要迭代,但排到其它待迭代题之后(如视觉题)
```

用法: python3 gen_task_status.py
输出: jobs/TASK_STATUS.md
"""
import json
import glob
import os


def load_overrides():
    path = "task_overrides.json"
    if not os.path.exists(path):
        return {}
    return json.load(open(path))


def load_trials():
    trials = []
    # jobs/<task>/<job>/<trial>/result.json (按题分文件夹，2026-07-23起)
    # archive/<批次>/<job>/<trial>/result.json (归档批次，扁平，未迁移)
    for rp in glob.glob("jobs/*/*/*/result.json") + glob.glob("archive/*/*/*/result.json"):
        try:
            d = json.load(open(rp))
        except Exception:
            continue
        task = (d.get("task_id") or {}).get("name")
        if not task:
            continue
        reward = ((d.get("verifier_result") or {}).get("rewards") or {}).get("reward")
        finished = d.get("finished_at")
        exc = d.get("exception_info")
        parts = rp.split("/")
        job = parts[2] if parts[0] == "jobs" else f"archive/{parts[1]}/{parts[2]}"
        trials.append({"task": task, "reward": reward, "time": finished or "", "exc": bool(exc), "job": job})
    return trials


def scan_log_mentions(task):
    path = "evolution-log.md"
    if not os.path.exists(path):
        return 0
    n = 0
    for line in open(path):
        if task in line and "真实难度" in line:
            n += 1
    return n


def main():
    meta = json.load(open("task_meta.json"))["tasks"]
    all_tasks = sorted(t["name"] for t in meta)
    trials = load_trials()
    overrides = load_overrides()

    by_task = {}
    for t in trials:
        by_task.setdefault(t["task"], []).append(t)

    rows = []
    for task in all_tasks:
        ts = sorted(by_task.get(task, []), key=lambda x: x["time"])
        attempts = len(ts)
        latest = ts[-1] if ts else None
        ever_passed = any(t["reward"] == 1 for t in ts)

        if latest is None:
            status, reward, last_job, last_time = "⬜ 未开始", "-", "-", "-"
        else:
            reward = latest["reward"]
            last_job = latest["job"]
            last_time = latest["time"] or "-"
            if reward == 1:
                status = "✅ 已通过"
            elif reward == 0:
                status = "🔁 待迭代" + ("(曾通过)" if ever_passed else "")
            elif latest["exc"]:
                status = "⚠️ 异常,待重跑" + ("(曾通过)" if ever_passed else "")
            else:
                status = "🔁 待迭代" + ("(曾通过)" if ever_passed else "")

        mentions = scan_log_mentions(task)
        notes = [f"日志提及'真实难度' {mentions} 次,建议复核"] if mentions else []

        override = overrides.get(task, {})
        tag = override.get("tag")
        # 已放弃只在还没通过时生效——真通过了就没有"放弃"这回事，以最新结果为准
        if tag == "abandoned" and reward != 1:
            status = "🚫 已放弃"
        if tag and override.get("reason"):
            label = {"abandoned": "已放弃", "low_priority": "低优先级"}.get(tag, tag)
            notes.append(f"[{label}] {override['reason']}")

        rows.append([task, status, reward, attempts, last_job, last_time, " / ".join(notes), tag])

    def priority_of(status, tag):
        # 用前缀判断,不用精确匹配--状态字符串可能带 "(曾通过)" 后缀
        if status.startswith("✅"):
            return 4  # 已通过,最后
        if status.startswith("🚫"):
            return 3  # 已放弃,不再投入,但排在已通过之前(跟"还没处理的"分开看)
        if tag == "low_priority":
            return 2  # 低优先级(如视觉题),其它待迭代题跑完再轮到它
        if status.startswith("⬜"):
            return 1  # 未开始
        return 0  # 🔁 待迭代 / ⚠️ 异常待重跑,最高优先级

    rows.sort(key=lambda r: r[5], reverse=True)  # 次序键:最近活动时间倒序,"-" 自然排最后
    rows.sort(key=lambda r: priority_of(r[1], r[7]))  # 主序键:状态优先级(稳定排序保留时间序)

    passed = sum(1 for r in rows if r[1].startswith("✅"))
    abandoned = sum(1 for r in rows if r[1].startswith("🚫"))
    pending = sum(1 for r in rows if r[1].startswith("🔁") or r[1].startswith("⚠️"))
    notstarted = sum(1 for r in rows if r[1].startswith("⬜"))

    with open("jobs/TASK_STATUS.md", "w") as f:
        f.write("# 按题迭代进度\n\n")
        f.write("自动生成，不进 git。刷新: `python3 gen_task_status.py`\n\n")
        f.write(f"共 {len(rows)} 题：已通过 {passed}，待迭代 {pending}，未开始 {notstarted}，已放弃 {abandoned}\n\n")
        f.write("下一轮迭代直接从下表状态非「✅ 已通过」「🚫 已放弃」的行里按顺序取，"
                "低优先级(如视觉题)排在其它待迭代题之后。"
                "「备注」列的日志线索不是结论；真要放弃/降优先级某题，编辑 `task_overrides.json`，"
                "不要只在备注里写一句就当处理完。\n\n")
        f.write("| task | 状态 | reward | 尝试次数 | 最新job | 最近活动 | 备注 |\n")
        f.write("|---|---|---|---|---|---|---|\n")
        for task, status, reward, attempts, last_job, last_time, note, _tag in rows:
            f.write(f"| {task} | {status} | {reward} | {attempts} | {last_job} | {last_time} | {note} |\n")

    print(f"已写入 jobs/TASK_STATUS.md：{len(rows)} 题，已通过 {passed}，待迭代 {pending}，"
          f"未开始 {notstarted}，已放弃 {abandoned}")


if __name__ == "__main__":
    main()
