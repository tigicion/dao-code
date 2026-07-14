#!/usr/bin/env python3
"""失败题自动体检——把"这题是任务难度还是DAO框架的锅"这个问题,从每次靠人记得去查
变成每道失败题跑一遍就有的固定产出。对应 README"基准驱动自进化"设计里说的"经验可观测"
debugger 那一层,之前一直是手工读日志时想起来才查,这个脚本把检查项固化下来。

用法: python3 diagnose_failure.py <job_dir>/<task_dir>
例:   python3 diagnose_failure.py jobs/iter4-qianfan-2048/large-scale-text-editing__wUBZLfG

输出固定检查这几项(每一项都是之前靠人工翻日志才发现问题的地方):
1. exception.txt 有没有,是不是 _handle_sigterm(外部杀进程)还是 AgentTimeoutError(自然超时)
2. tool-trace.jsonl 的调用跨度 vs task_meta.json 的 agent_timeout_sec——跨度远小于预算
   但又没有 exception,是"静默提前结束"的强信号(loop.ts 空响应 bug 就是这么揪出来的)
3. verify_done 有没有被调用过
4. "[收尾前检查]"这条 L4.5 提醒有没有出现过、模型有没有回应
5. perm-trace.jsonl 里 ask-denied 占比——占比高是"模型反复想做一件事却被权限系统拦住"
   的强信号(schemelike-metacircular-eval/tune-mjcf 的 eval.scm/eval.py 假阳性就是
   这么揪出来的:文件名撞上 isDangerousCommand 的 eval/sudo 检测正则,无 TTY 下
   ask 自动转 deny,模型反复重试却始终被拦,最后被迫放弃真实验证)。占比高时应该去
   dao_stdout.txt 搜"reject"/"denied"/"拒绝"找模型自己对这件事的反应原文。
6. dao_stdout.txt 最后 30 行原文,供人工再读一遍收尾方式
"""
import json
import sys
from pathlib import Path

def main():
    if len(sys.argv) != 2:
        print("用法: python3 diagnose_failure.py <task_job_dir>", file=sys.stderr)
        sys.exit(1)
    task_dir = Path(sys.argv[1])
    task_name = task_dir.name.split("__")[0]
    root = task_dir.parents[1] if task_dir.parents[1].name == "jobs" else Path(__file__).parent.parent

    print(f"=== 体检: {task_dir.name} (task={task_name}) ===\n")

    # 1. exception 签名
    exc = task_dir / "exception.txt"
    if exc.exists():
        text = exc.read_text()
        sig = "_handle_sigterm(外部杀进程,需清理重跑)" if "_handle_sigterm" in text else (
            "AgentTimeoutError(自然超时)" if "AgentTimeoutError" in text else "未知签名")
        print(f"[1] exception: {sig}")
    else:
        print("[1] exception: 无(干净完成或干净失败)")

    # 2. tool-trace 跨度 vs 预算
    trace_files = list((task_dir / "agent" / "dao_snapshot" / ".dao" / "sessions").glob("*/tool-trace.jsonl")) \
        if (task_dir / "agent" / "dao_snapshot" / ".dao" / "sessions").exists() else []
    meta_path = Path(__file__).parent.parent / "task_meta.json"
    budget = None
    if meta_path.exists():
        meta = json.loads(meta_path.read_text())
        t = next((x for x in meta["tasks"] if x.get("name") == task_name), None)
        budget = t.get("agent_timeout_sec") if t else None
    if trace_files:
        lines = [json.loads(l) for l in trace_files[0].read_text().splitlines() if l.strip()]
        if lines:
            span = (lines[-1]["ts"] - lines[0]["ts"]) / 1000
            print(f"[2] 工具调用: {len(lines)} 次,跨度 {span:.0f}s,任务预算 {budget}s"
                  + ("" if budget is None else f"(占比 {span/budget*100:.0f}%)"))
            if budget and span < budget * 0.5 and not exc.exists():
                print("    ⚠ 跨度远小于预算但无 exception——疑似静默提前结束,不要直接归为'任务难度',",
                      "去读 dao_stdout.txt 最后一段原始收尾方式确认。")
    else:
        print("[2] 未找到 tool-trace.jsonl")

    # 3/4. verify_done + 收尾前检查
    stdout_path = task_dir / "agent" / "dao_stdout.txt"
    if stdout_path.exists():
        text = stdout_path.read_text(errors="ignore")
        print(f"[3] verify_done 调用次数: {text.count('verify_done')}")
        print(f"[4] '[收尾前检查]'提醒出现次数: {text.count('收尾前检查')}")
    else:
        text = None
        print("[3/4] 未找到 dao_stdout.txt")

    # 5. perm-trace ask-denied 占比
    perm_files = list((task_dir / "agent" / "dao_snapshot" / ".dao" / "sessions").glob("*/perm-trace.jsonl")) \
        if (task_dir / "agent" / "dao_snapshot" / ".dao" / "sessions").exists() else []
    if perm_files:
        perm_lines = [json.loads(l) for l in perm_files[0].read_text().splitlines() if l.strip()]
        total = len(perm_lines)
        denied = sum(1 for p in perm_lines if p.get("decision") == "ask-denied")
        if total:
            pct = denied / total * 100
            print(f"[5] 权限裁决: 共 {total} 次,ask-denied {denied} 次({pct:.0f}%)")
            if pct >= 15:
                print(f"    ⚠ ask-denied 占比 {pct:.0f}% 偏高——去 dao_stdout.txt 搜",
                      "'reject'/'denied'/'拒绝' 看模型自己对这件事的反应,",
                      "很可能是某个正常操作(比如文件名撞上 eval/sudo 检测正则)被系统性误拦,",
                      "不是任务难度本身。")
    else:
        print("[5] 未找到 perm-trace.jsonl")

    # 6. 最后30行原文
    if text is not None:
        print("\n[6] dao_stdout.txt 最后 30 行(人工复核收尾方式):")
        print("-" * 60)
        print("\n".join(text.splitlines()[-30:]))

if __name__ == "__main__":
    main()
