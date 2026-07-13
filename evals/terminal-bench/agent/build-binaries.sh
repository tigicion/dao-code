#!/bin/bash
# 从当前 git HEAD 交叉编译两个架构的 DAO 二进制,供 harbor_dao_agent.py 装机用。
# 输出到 ./bin/(gitignored,构建产物不入仓)。跑分前记得跑一次,保证测的是当前源码而不是旧二进制。
set -euo pipefail
cd "$(dirname "$0")/../../.."   # 回到 dao-code 仓库根

OUT="evals/terminal-bench/agent/bin"
mkdir -p "$OUT"

node scripts/sync-version.mjs
bun build ./src/index.ts --compile --target=bun-linux-x64 --outfile="$OUT/dao-linux-x64"
bun build ./src/index.ts --compile --target=bun-linux-arm64 --outfile="$OUT/dao-linux-arm64"

echo "已编译(commit $(git rev-parse --short HEAD)):"
ls -la "$OUT"
