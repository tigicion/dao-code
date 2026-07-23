#!/usr/bin/env python3
"""从 results.json + evolution-log.md 生成 results.md 汇总表。

用法: python3 gen_results_md.py
读取: results.json, evolution-log.md
输出: results.md
"""
import json, re, os
from datetime import datetime

results = json.load(open("results.json"))
log_text = open("evolution-log.md").read()

# 用户确认 adaptive-rejection-sampler 已通过 Write-first 复测（本会话外跑，无 job 数据）
ARS_PASSED = True  # 用户确认

# 归因摘要提取：在 evolution-log.md 里搜索每道题的结论
def get_diagnosis(task, log):
    """从 evolution-log.md 提取每道题的排查结论摘要。"""
    lines = log.split("\n")
    conclusions = []
    for i, line in enumerate(lines):
        if task in line:
            # 搜索附近的结论行
            for j in range(max(0, i-2), min(len(lines), i+5)):
                l = lines[j].strip()
                if any(kw in l for kw in [
                    "确认真实难度", "反复推理反模式", "意图-行动脱节",
                    "真实精度", "模型判断失误", "框架bug", "已修复",
                    "自然超时", "非反模式", "混合型", "反模式变体",
                    "Weak Verification", "Premature Termination",
                    "Step Repetition", "reward=0", "reward=1",
                    "未确认为反模式", "真实任务难度", "非真实失败",
                ]):
                    conclusions.append(l[:200])
                    break
    # 去重
    seen = set()
    unique = []
    for c in conclusions:
        if c not in seen:
            seen.add(c)
            unique.append(c)
    return unique[-1] if unique else ""  # 取最后一条（最新结论）

# 分类
passed = []
failed = []
no_result = []

for r in results:
    r["diagnosis"] = get_diagnosis(r["task"], log_text)
    if r["reward"] == 1:
        passed.append(r)
    elif r["reward"] == 0:
        # ARS 特殊处理
        if r["task"] == "adaptive-rejection-sampler" and ARS_PASSED:
            r["reward"] = 1  # 更新为通过
            r["diagnosis"] = "Write-first规则(226f55f)复测通过（用户确认，无job数据）"
            passed.append(r)
        else:
            failed.append(r)
    else:
        no_result.append(r)

passed.sort(key=lambda x: x["task"])
failed.sort(key=lambda x: x["task"])
no_result.sort(key=lambda x: x["task"])

# 生成 markdown
lines = []
lines.append("# Terminal-Bench 结果汇总")
lines.append("")
lines.append(f"最后更新: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
lines.append(f"DAO版本: {os.popen('git log --oneline -1').read().strip()}")
lines.append(f"二进制commit: {os.popen('git rev-parse --short HEAD').read().strip()}")
lines.append("")
lines.append(f"**总计 {len(results)} 题 | 通过 {len(passed)} | 未通过 {len(failed)} | 无结果 {len(no_result)}**")
lines.append(f"通过率: {len(passed)}/{len(passed)+len(failed)} = {len(passed)/(len(passed)+len(failed))*100:.1f}%")
lines.append("")

# 未通过题表（重点）
lines.append("## 未通过题（按题名排序）")
lines.append("")
lines.append("| # | 题目 | 难度 | 类别 | 最新运行时间 | provider | exc | 轮次 | 工具调用 | token_in | token_out | trace 目录 | 排查结论 |")
lines.append("|---|------|------|------|-------------|----------|-----|------|---------|----------|-----------|-----------|---------|")
for i, r in enumerate(failed, 1):
    tok_in = f"{r['tokens_in']:,}" if r['tokens_in'] else "-"
    tok_out = f"{r['tokens_out']:,}" if r['tokens_out'] else "-"
    exc = r['exc_type'] or "-"
    diag = r['diagnosis'].replace("|", "\\|")[:80] if r['diagnosis'] else "-"
    lines.append(f"| {i} | {r['task']} | {r['difficulty']} | {r['category']} | {r['time']} | {r['provider']} | {exc} | {r['turns']} | {r['tool_calls']} | {tok_in} | {tok_out} | `{r['trial_dir']}` | {diag} |")

lines.append("")

# 通过题表（简洁）
lines.append("## 已通过题")
lines.append("")
lines.append("| # | 题目 | 难度 | 最新运行时间 | provider | 轮次 | 工具调用 | trace 目录 |")
lines.append("|---|------|------|-------------|----------|------|---------|-----------|")
for i, r in enumerate(passed, 1):
    lines.append(f"| {i} | {r['task']} | {r['difficulty']} | {r['time']} | {r['provider']} | {r['turns']} | {r['tool_calls']} | `{r['trial_dir']}` |")

lines.append("")

# 无结果
if no_result:
    lines.append("## 无结果")
    lines.append("")
    for r in no_result:
        lines.append(f"- {r['task']}: {r['exc_type'] or 'unknown'} ({r['time']}, {r['trial_dir']})")
    lines.append("")

# 待闭环事项
lines.append("## 待闭环事项")
lines.append("")
lines.append("- [ ] `make-mips-interpreter` 大文件单次 write_file 导致 qianfan 流失败 -- 三次写千行级 vm.js 全失败")
lines.append("- [ ] `build-pmars` verify_done 零参数不锚定任务原文验收点 -- 两轮修复后复测仍 reward=0")
lines.append("- [ ] `regex-chess` reasoning 阶段自身不收敛 -- 候选(a)(b)(c)均未翻转 reward，已结案保留(c)省成本")
lines.append("")

# 最近 EVOLVE 周期
lines.append("## 最近 EVOLVE 周期")
lines.append("")
lines.append("| commit | 内容 | 复测状态 |")
lines.append("|--------|------|---------|")
lines.append("| `226f55f` | Write-first规则:推理中产出完整代码后必须先落盘再修bug | adaptive-rejection-sampler复测通过(用户确认) |")
lines.append("| `330f166` | onEmptyTruncation重试叠加硬max_tokens上限 | 机制生效(成本降55%/22%),未翻转reward,已结案 |")
lines.append("| `5f91c45` | 收敛提示改结构性约束 | 不足以解决,已被(c)间接验证 |")
lines.append("| `e152a75` | 重试调低reasoning_effort | 机制不足,探测脚本排除参数无效误判 |")
lines.append("")

with open("results.md", "w") as f:
    f.write("\n".join(lines))

print(f"已生成 results.md: {len(passed)} passed, {len(failed)} failed, {len(no_result)} no_result")
