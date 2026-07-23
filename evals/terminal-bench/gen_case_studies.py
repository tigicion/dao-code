#!/usr/bin/env python3
"""从 improvements.jsonl 挑 summary_public 非空的条目，渲染成对外展示的改进案例集。

公开与否完全由台账里 summary_public 字段是否填写决定——留空就不出现在这份文档里。

用法: python3 gen_case_studies.py
输出: IMPROVEMENTS.md
"""
import json
import os


def main():
    path = "improvements.jsonl"
    entries = []
    if os.path.exists(path):
        for line in open(path):
            line = line.strip()
            if line:
                entries.append(json.loads(line))

    public = [e for e in entries if e.get("summary_public")]
    public.sort(key=lambda e: e.get("date", ""))

    with open("IMPROVEMENTS.md", "w") as f:
        f.write("# DAO 在 Terminal-Bench 上的改进案例\n\n")
        f.write("自动生成，来自 `improvements.jsonl`（只收录 `summary_public` 字段非空的条目）。")
        f.write("刷新: `python3 gen_case_studies.py`\n\n")
        for e in public:
            tasks = "、".join(e.get("tasks_affected", []))
            before = e.get("before_reward")
            after = e.get("after_reward")
            f.write(f"## {e.get('date', '?')} · {tasks}\n\n")
            if before is not None and after is not None:
                f.write(f"reward: {before} → {after}\n\n")
            f.write(f"{e['summary_public']}\n\n")

    print(f"已写入 IMPROVEMENTS.md，共 {len(public)} 条案例（台账总条目 {len(entries)}）")


if __name__ == "__main__":
    main()
