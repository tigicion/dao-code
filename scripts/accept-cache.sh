#!/usr/bin/env bash
# 缓存命中(优势 c)真网络验收:多轮对话,turn1 冷启动(全 miss)→ turn2+ 复用稳定前缀(命中)。
# 在 turn1 后与多轮后各打一次 /cost,两次命中率对比 = 看见缓存"开始生效"。需 DeepSeek key、产生少量费用。
#   跑:  DEEPSEEK_API_KEY=sk-... npm run accept:cache
#   然后把全部输出贴回给 Claude 判定:① API 真回了 cache 字段?② 命中率随轮次上升(目标稳态 ≥90%)?
set -uo pipefail
: "${DEEPSEEK_API_KEY:?请先 export DEEPSEEK_API_KEY=你的key}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TSX="$REPO/node_modules/.bin/tsx"
WS="$(mktemp -d)"
strip() { sed $'s/\x1b\\[[0-9;]*m//g'; }

echo "=== 临时工作区: $WS ==="
echo "=== 多轮对话(低思考档,只为快;缓存与思考强度无关)==="

# 行即一轮。第 1 个 /cost 在冷启动后(应≈0% 命中),第 2 个在 3 轮后(命中率应明显上升)。
printf '%s\n' \
  "你好,用一句话介绍你自己就好" \
  "/cost" \
  "用一句话讲讲什么是闭包" \
  "再用一句话讲讲什么是递归" \
  "/cost" \
  "/exit" \
| ( cd "$WS" && DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" CODEDS_AUTO_APPROVE=1 CODEDS_REASONING_EFFORT=low "$TSX" "$REPO/src/index.ts" ) 2>&1 | strip > "$WS/cache.out"

echo "--- /cost 两次输出(冷启动 vs 多轮后)---"
grep -n "本会话用量\|本会话暂无" "$WS/cache.out" || echo "(没找到 /cost 输出 —— 可能 API 没在流式里回 usage)"
echo
echo "--- 完整输出(尾部)---"
tail -n 40 "$WS/cache.out"
echo
echo "=== 自动初判(最终由 Claude 确认)==="
RATIOS=$(grep -o "命中率 [0-9.]*%" "$WS/cache.out" | tr '\n' ' ')
echo "出现的命中率: ${RATIOS:-（无）}  （期望:第一次≈0%、之后明显 >0 并随轮次上升）"
echo
echo "=== 把以上全部输出贴回给 Claude 判定。工作区留在 ${WS} (验完可 rm -rf) ==="
