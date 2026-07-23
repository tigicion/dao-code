#!/usr/bin/env bash
# 生成 jobs/INDEX.md：当前 jobs/ 目录下每个 job 的一览表(task/job/reward/时间)
# jobs/ 按题分文件夹(jobs/<task>/<job>/)，2026-07-23起
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
  echo "| task | job | reward | trial数 | 修改时间 |"
  echo "|---|---|---|---|---|"

  for taskdir in jobs/*/; do
    task=$(basename "$taskdir")
    [ "$task" = "archive" ] && continue
    [ -f "$taskdir" ] && continue  # 跳过 jobs/ 下的散落文件(如 INDEX.md)

    for d in "$taskdir"*/; do
      [ -d "$d" ] || continue
      job=$(basename "$d")

      trials=$(find "$d" -mindepth 1 -maxdepth 1 -type d 2>/dev/null)
      n=$(echo "$trials" | grep -c .)
      [ -z "$trials" ] && n=0

      reward="-"
      if [ "$n" -eq 1 ]; then
        trial_dir=$(echo "$trials" | head -1)
        rp="${trial_dir}/verifier/reward.txt"
        [ -f "$rp" ] && reward=$(cat "$rp" 2>/dev/null)
        [ -f "${trial_dir}/exception.txt" ] && reward="EXCEPTION"
      fi

      mtime=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M" "$d" 2>/dev/null || stat -c "%y" "$d" 2>/dev/null | cut -d. -f1)

      echo "| $task | $job | $reward | $n | $mtime |"
    done
  done | sort -t'|' -k5 -r

  echo
  echo "归档批次(不在上表): \`archive/\` 下按批次分组，见 \`archive/pre-round-0723/\`。"
} > "$OUT"

echo "已生成 $OUT"
