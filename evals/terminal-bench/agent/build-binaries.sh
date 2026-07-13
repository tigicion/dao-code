#!/bin/bash
# 从当前 checkout 交叉编译两个架构的 DAO 二进制,供 harbor_dao_agent.py 装机用。
# 输出到 ./bin/(BIN_DIR=<相对 evals/terminal-bench/agent 的路径> 可指到别处,比如 A/B 测另一个 commit
# 时用 BIN_DIR=bin-baseline 避免覆盖当前 HEAD 的二进制)。跑分前记得跑一次,保证测的是想测的源码。
set -euo pipefail
cd "$(dirname "$0")/../../.."   # 回到 dao-code 仓库根

OUT="evals/terminal-bench/agent/${BIN_DIR:-bin}"
mkdir -p "$OUT"

node scripts/sync-version.mjs
bun build ./src/index.ts --compile --target=bun-linux-x64 --outfile="$OUT/dao-linux-x64"
bun build ./src/index.ts --compile --target=bun-linux-arm64 --outfile="$OUT/dao-linux-arm64"

echo "已编译(commit $(git rev-parse --short HEAD)):"
ls -la "$OUT"
