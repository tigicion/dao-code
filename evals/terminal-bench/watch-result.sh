#!/usr/bin/env bash
# 监控 terminal-bench job 结果，一出现就通知
# 用法: bash watch-result.sh <job_name>
#   job_name 不用带 task 前缀，会自动在 jobs/<task>/<job_name>/ 下定位
cd "$(dirname "$0")"
JOB="$1"
if [ -z "$JOB" ]; then
  echo "用法: bash watch-result.sh <job_name>"
  exit 1
fi

while true; do
  JOBDIR=$(find jobs -maxdepth 2 -type d -name "${JOB}" 2>/dev/null | head -1)
  if [ -n "$JOBDIR" ]; then
    R=$(find "$JOBDIR" -name "reward.txt" 2>/dev/null | head -1)
    if [ -n "$R" ]; then
      VAL=$(cat "$R")
      osascript -e "display notification \"${JOB}: reward=${VAL}\" with title \"Terminal-Bench 完成\" sound name \"Glass\""
      echo "DONE: ${JOB} reward=${VAL}"
      exit 0
    fi
    E=$(find "$JOBDIR" -name "exception.txt" 2>/dev/null | head -1)
    if [ -n "$E" ]; then
      osascript -e "display notification \"${JOB}: exception\" with title \"Terminal-Bench 完成\" sound name \"Basso\""
      echo "DONE: ${JOB} exception"
      exit 0
    fi
  fi
  # harbor 进程死了也没结果
  if ! pgrep -f "harbor run.*${JOB}" > /dev/null 2>&1; then
    osascript -e "display notification \"${JOB}: harbor 进程退出，无结果\" with title \"Terminal-Bench 异常\" sound name \"Basso\""
    echo "DONE: ${JOB} harbor died"
    exit 1
  fi
  sleep 10
done
