#!/usr/bin/env python3
"""按 task_meta.json 的 memory_mb 把一批题目分桶,配不同并发数——避免高内存题目和低内存题目
混在同一个 harbor run(单一 -n)里挤爆 Docker VM 的内存预算,也避免为了迁就高内存题目
而把所有题目的并发都压得很低、拖慢迭代速度。

用法: python3 batch_by_memory.py <task1> <task2> ...
输出: 三个内存桶各自的题目列表 + 建议的 -n,直接拼进对应的 harbor run 命令。

阈值怎么来的(见 evals/terminal-bench/README.md "并发与内存分桶"一节):
Docker VM 总预算实测约 12.5GB。每桶 -n × 桶内存上限 ≈ 8GB,留 ~4.5GB 给 host/harbor 自身
开销,不是精确计算,是留够余量防止贴着预算上限跑导致偶发 OOM 引入新的不稳定源。
"""
import json
import sys
from pathlib import Path

BUCKETS = [
    (2048, 4),  # (内存上限MB, 建议并发数)
    (4096, 2),
    (8192, 1),
]

def main():
    names = sys.argv[1:]
    if not names:
        print("用法: python3 batch_by_memory.py <task1> <task2> ...", file=sys.stderr)
        sys.exit(1)
    meta = json.loads((Path(__file__).parent.parent / "task_meta.json").read_text())
    by_name = {t["name"]: t for t in meta["tasks"]}
    groups: dict[int, list[str]] = {mem: [] for mem, _ in BUCKETS}
    for n in names:
        t = by_name.get(n)
        mem = t.get("memory_mb", 2048) if t else 2048
        bucket = next((b for b, _ in BUCKETS if mem <= b), BUCKETS[-1][0])
        groups[bucket].append(n)
    for mem, concurrency in BUCKETS:
        tasks = groups[mem]
        if not tasks:
            continue
        print(f"\n# {mem}MB 桶,{len(tasks)} 题,建议 -n {concurrency}")
        for t in tasks:
            print(f'  -i "terminal-bench/{t}" \\')
        print(f"  -n {concurrency}")

if __name__ == "__main__":
    main()
