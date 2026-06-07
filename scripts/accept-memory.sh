#!/usr/bin/env bash
# 记忆 P2/P3 真网络验收编排:在隔离的临时工作区跑两段会话,产出"蒸馏记忆 + 跨会话召回"
# 两类证据,供人/模型判定效果。需 DeepSeek key、会产生少量费用。
#   跑:  DS_API_KEY=sk-... npm run accept:mem
#   然后把本脚本的【全部输出】贴回给 Claude,由它确认效果(蒸馏质量 / 是否纯靠记忆作答)。
set -uo pipefail
: "${DS_API_KEY:?请先 export DS_API_KEY=你的key}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TSX="$REPO/node_modules/.bin/tsx"
WS="$(mktemp -d)"
strip() { sed $'s/\x1b\\[[0-9;]*m//g'; }
# 同一工作区 WS 跑 codeds:project 记忆落在 WS/.codeds/memory,run2 能读到 run1 蒸馏的记忆。
run() { ( cd "$WS" && DEEPSEEK_API_KEY="$DS_API_KEY" CODEDS_AUTO_APPROVE=1 "$TSX" "$REPO/src/index.ts" ); }

echo "=== 临时工作区: $WS ==="

echo; echo "=== run1:交代用户信息(陈述,不用'记住'),交互式退出时应自动蒸馏 ==="
MSG1="我在 macOS 上用 pnpm 管理依赖,平时在学习 AI agent 的实现原理。先随便回我一句就行。"
echo "输入: $MSG1"
printf '%s\n' "$MSG1" | run 2>&1 | strip > "$WS/run1.out"
echo "--- run1 输出尾部(应见『已更新记忆:N 条』)---"; tail -n 6 "$WS/run1.out"

echo; echo "=== run1 蒸馏产物:.codeds/memory/*.md ==="
if compgen -G "$WS/.codeds/memory/*.md" > /dev/null; then
  for f in "$WS"/.codeds/memory/*.md; do echo "----- $f -----"; cat "$f"; echo; done
else
  echo "(未生成记忆文件 —— 蒸馏可能没产出,需排查)"
fi

echo; echo "=== run2:新进程,问没明说过的偏好,应从记忆直接答、不调工具 ==="
MSG2="我平时用什么包管理器?直接告诉我。"
echo "输入: $MSG2"
printf '%s\n' "$MSG2" | run 2>&1 | strip > "$WS/run2.out"
echo "--- run2 完整输出 ---"; cat "$WS/run2.out"

echo; echo "=== 自动初判(最终由 Claude 确认)==="
grep -qi "pnpm" "$WS/run2.out" && echo "✓ run2 提到 pnpm" || echo "✗ run2 未提到 pnpm"
TOOLS=$(grep -c "→ " "$WS/run2.out" 2>/dev/null || echo 0)
echo "run2 工具调用标记(→)数: $TOOLS  (期望 0 = 纯靠记忆作答,而非现查文件)"
echo
echo "=== 完成。把以上【全部输出】贴回给 Claude 判定效果。工作区留在 $WS(验完可 rm -rf)==="
