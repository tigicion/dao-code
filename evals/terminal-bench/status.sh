#!/usr/bin/env bash
# 查看 terminal-bench 正在运行的 job 的实时状态
# 用法: bash status.sh [job_name]
#   不带参数：自动找最新运行的 job
cd "$(dirname "$0")"

if [ -n "$1" ]; then
  JOB="$1"
else
  # 找最新的有 dao_stdout 的 job 目录
  JOB=$(ls -t jobs/*/agent/dao_stdout.txt 2>/dev/null | head -1 | sed 's|jobs/||;s|/agent/dao_stdout.txt||')
fi

if [ -z "$JOB" ]; then
  echo "没有找到运行中的 job"
  exit 0
fi

TRIAL=$(ls -d "jobs/${JOB}"/*/ 2>/dev/null | head -1)
if [ -z "$TRIAL" ]; then
  echo "job=${JOB} 但无 trial 目录"
  exit 0
fi

TASK=$(basename "$TRIAL" | sed 's/__.*//')
STDOUT="${TRIAL}agent/dao_stdout.txt"

echo "=============================================="
echo "job:   ${JOB}"
echo "task:  ${TASK}"
echo "=============================================="

# 结果
if [ -f "${TRIAL}verifier/reward.txt" ]; then
  echo "结果:  reward=$(cat "${TRIAL}verifier/reward.txt") ✅ 已完成"
elif [ -f "${TRIAL}exception.txt" ]; then
  EXC=$(head -1 "${TRIAL}exception.txt" 2>/dev/null)
  echo "结果:  EXCEPTION (${EXC})"
else
  echo "结果:  ⏳ 运行中"
fi

# docker 状态
CONTAINER=$(docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null | grep -i "${TASK}" | head -1)
if [ -n "$CONTAINER" ]; then
  echo "容器:  ${CONTAINER}"
else
  echo "容器:  (无运行中容器)"
fi

# dao_stdout 统计
if [ -f "$STDOUT" ]; then
  LINES=$(wc -l < "$STDOUT")
  SIZE=$(du -h "$STDOUT" | cut -f1)
  echo "输出:  ${LINES} 行 / ${SIZE}"
else
  echo "输出:  (无 dao_stdout.txt)"
  exit 0
fi

# 工具调用统计
TRACE=$(find "${TRIAL}agent/" -name "tool-trace.jsonl" 2>/dev/null | head -1)
if [ -n "$TRACE" ]; then
  python3 -c "
import json
from collections import Counter
tools = Counter()
turns = 0
for line in open('$TRACE'):
    d = json.loads(line)
    if d.get('kind') == 'call':
        tools[d.get('name')] += 1
    if d.get('turn', 0) > turns:
        turns = d.get('turn')
print(f'轮次:  {turns + 1}')
print(f'工具:  ' + ', '.join(f'{n}×{c}' for n, c in tools.most_common()))
" 2>/dev/null
fi

# 最近活动（最后10行 dao_stdout，去掉 ANSI 码）
echo "----------------------------------------------"
echo "最近输出:"
tail -10 "$STDOUT" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | head -10
