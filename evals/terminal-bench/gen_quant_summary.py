#!/usr/bin/env python3
"""从 improvements.jsonl 统计失败模式分布和修复数量，输出量化摘要。

用法: python3 gen_quant_summary.py
输出: QUANT_SUMMARY.md
"""
import json
import os
from collections import Counter


def main():
    path = "improvements.jsonl"
    entries = []
    if os.path.exists(path):
        for line in open(path):
            line = line.strip()
            if line:
                entries.append(json.loads(line))

    mode_counter = Counter()
    tasks_fixed = set()
    verified_fixes = 0
    for e in entries:
        for m in e.get("failure_mode", []):
            mode_counter[m] += 1
        if e.get("verified") and e.get("before_reward") == 0 and e.get("after_reward") == 1:
            verified_fixes += 1
            tasks_fixed.update(e.get("tasks_affected", []))

    with open("QUANT_SUMMARY.md", "w") as f:
        f.write("# 量化摘要\n\n")
        f.write("自动生成，来自 `improvements.jsonl`。刷新: `python3 gen_quant_summary.py`\n\n")
        f.write(f"- 台账总条目: {len(entries)}\n")
        f.write(f"- 已真实复测确认的修复: {verified_fixes} 次，覆盖 {len(tasks_fixed)} 道题\n\n")
        f.write("## 失败模式分布\n\n| 模式 | 出现次数 |\n|---|---|\n")
        for mode, count in mode_counter.most_common():
            f.write(f"| {mode} | {count} |\n")

    print("已写入 QUANT_SUMMARY.md")


if __name__ == "__main__":
    main()
