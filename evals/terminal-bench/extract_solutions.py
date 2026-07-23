#!/usr/bin/env python3
"""从 harbor 缓存提取所有未通过题的 instruction + solution，生成参考文件。"""
import json, os, pathlib, textwrap

CACHE = pathlib.Path(os.path.expanduser("~/.cache/harbor/tasks/packages/terminal-bench"))
RESULTS = pathlib.Path(__file__).parent / "results.json"
OUTPUT = pathlib.Path(__file__).parent / "solutions-reference.md"

# 加载结果
with open(RESULTS) as f:
    tasks = json.load(f)
if isinstance(tasks, dict):
    tasks = tasks.get("tasks", tasks)

# 找未通过的题
failed = [t for t in tasks if t.get("reward") != 1]
failed_names = {t["task"] for t in failed}

# 遍历缓存
lines = ["# 未通过题标准解法参考（从 harbor 缓存提取）\n"]
lines.append(f"未通过题数: {len(failed_names)}\n\n---\n")

found = 0
for task_dir in sorted(CACHE.iterdir()):
    task_name = task_dir.name
    if task_name not in failed_names:
        continue
    # 缓存结构: terminal-bench/<task_name>/<hash>/
    for hash_dir in task_dir.iterdir():
        instr_path = hash_dir / "instruction.md"
        sol_dir = hash_dir / "solution"
        if not instr_path.exists():
            continue
        found += 1
        lines.append(f"## {task_name}\n")
        lines.append("### Instruction\n")
        lines.append(f"```\n{instr_path.read_text().strip()}\n```\n")
        # solution
        if sol_dir.exists():
            for sol_file in sol_dir.iterdir():
                if sol_file.suffix in (".sh", ".py", ".cmd", ".bat", ".ps1"):
                    lines.append(f"### Solution ({sol_file.name})\n")
                    lines.append(f"```bash\n{sol_file.read_text().strip()}\n```\n")
        # tests
        tests_dir = hash_dir / "tests"
        if tests_dir.exists():
            for test_file in tests_dir.iterdir():
                if test_file.suffix == ".py":
                    lines.append(f"### Test ({test_file.name})\n")
                    lines.append(f"```python\n{test_file.read_text().strip()}\n```\n")
        lines.append("\n---\n")

lines.insert(2, f"找到解法: {found}/{len(failed_names)}\n")
OUTPUT.write_text("\n".join(lines))
print(f"已生成 {OUTPUT}: {found}/{len(failed_names)} 题的解法")
