#!/usr/bin/env bash
# 生成 jobs/INDEX.md：当前 jobs/ 目录下每个 job 的一览表(类型/task/reward/时间)
# 用法: bash gen_index.sh
cd "$(dirname "$0")"

OUT="jobs/INDEX.md"
mkdir -p jobs

{
  echo "# jobs/ 索引"
  echo
  echo "自动生成，不进 git。刷新: \`bash gen_index.sh\`"
  echo
  echo "生成时间: $(date '+%Y-%m-%d %H:%M:%S')"
  echo
  echo "| job | 类型 | task | reward | trial数 | 修改时间 |"
  echo "|---|---|---|---|---|---|"

  for d in jobs/*/; do
    job=$(basename "$d")
    [ "$job" = "archive" ] && continue

    trials=$(find "$d" -mindepth 1 -maxdepth 1 -type d 2>/dev/null)
    n=$(echo "$trials" | grep -c . )
    [ -z "$trials" ] && n=0

    if [ "$n" -gt 1 ]; then
      kind="批次"
      task="(${n}题,见下)"
    elif [ "$n" -eq 1 ]; then
      kind="单题"
      trial_dir=$(echo "$trials" | head -1)
      task=$(basename "$trial_dir" | sed 's/__.*//')
    else
      kind="(空)"
      task="-"
    fi

    reward="-"
    if [ "$n" -eq 1 ]; then
      rp="${trial_dir}/verifier/reward.txt"
      [ -f "$rp" ] && reward=$(cat "$rp" 2>/dev/null)
      [ -f "${trial_dir}/exception.txt" ] && reward="EXCEPTION"
    fi

    mtime=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M" "$d" 2>/dev/null || stat -c "%y" "$d" 2>/dev/null | cut -d. -f1)

    echo "| $job | $kind | $task | $reward | $n | $mtime |"
  done | sort -t'|' -k6 -r

  echo
  echo "归档批次(不在上表): \`archive/\` 下按批次分组，见 \`archive/pre-round-0723/\`。"
} > "$OUT"

echo "已生成 $OUT"
