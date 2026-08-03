#!/usr/bin/env bash
# pro + default账号 独立赛道:全量 87 题(89 题去掉2道视觉题,与主赛道视觉题单独处理的
# 惯例保持一致)真实跑分,完全独立于 DS-Pro 主赛道(jobs/、results.json、evolution-log.md)
# 和 flash+default 赛道(jobs-flash-default/、results-flash-default.json)。
#
# 目的:用 default 账号(DeepSeek 官方 key,而非 huoshan/volcengine)+ deepseek-v4-pro
# 模型,对全量题目做一次最新的 pass@1 复测,跟已有的两条赛道互不覆盖、互不污染。
#
# 隔离设计:
# - --jobs-dir jobs-pro-default(独立目录,collect_results.py 的 glob 只认 jobs/*/*/,
#   不会扫到这里,主赛道 results.json 永不受影响;跟 jobs-flash-default 也是两个目录)
# - --env-file .env-default(DeepSeek 官方 key,跟 huoshan1/hs_year 额度独立)
# - --ak model=deepseek-v4-pro(显式指定,不依赖 provider 默认模型——即便当前默认碰巧
#   也是这个,显式写出来不用去翻 profiles.ts 确认,也不怕以后默认值变了不自知)
# - 结果表用 collect_results_pro_default.py / gen_results_html_pro_default.py 单独产出
#   results-pro-default.json / results-pro-default.html
# - 排查记录写 evolution-log-pro-default.md,不追加进主赛道的 evolution-log.md
#
# 按内存分三桶顺序跑(不能桶间并发——Docker VM 总预算约12.5GB,分桶设计假设同一时刻
# 只有一桶在跑,见 README.md「并发与内存分桶」):
#   2048MB 桶 66 题 -n 4 → 4096MB 桶 13 题(qemu 两题 --force-build 单独跑,见下)
#   -n 2 → 8192MB 桶 8 题 -n 1
set -uo pipefail
cd "$(dirname "$0")"
source venv/bin/activate

LOG="auto-iterate-pro-default.log"
PROVIDER="deepseek"
ENV_FILE=".env-default"
MODEL="deepseek-v4-pro"
JOBS_DIR="jobs-pro-default"
DATE_TAG=$(date +%m%d)

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"
}

run_bucket() {
  local bucket_name="$1"
  local concurrency="$2"
  local force_build="$3"
  shift 3
  local tasks=("$@")
  local job_name="pro-${bucket_name}-${DATE_TAG}"

  log "=== 开始 ${bucket_name} 桶: ${#tasks[@]} 题, -n ${concurrency}, job-name=${job_name}, force_build=${force_build} ==="

  local args=(-d terminal-bench/terminal-bench-2-1
    --agent-import-path agent.harbor_dao_agent:DaoAgent
    --ak "provider=${PROVIDER}"
    --ak "model=${MODEL}"
    --env-file "${ENV_FILE}"
    --agent-timeout-multiplier 1)
  if [[ "${force_build}" == "1" ]]; then
    args+=(--force-build)
  fi
  for t in "${tasks[@]}"; do
    args+=(-i "terminal-bench/${t}")
  done
  args+=(-n "${concurrency}" -y --jobs-dir "${JOBS_DIR}" --job-name "${job_name}")

  harbor run "${args[@]}" 2>&1 | tee -a "$LOG"

  log "=== ${bucket_name} 桶完成,更新 pro-default 结果表 ==="
  python3 collect_results_pro_default.py 2>&1 | tee -a "$LOG"
  python3 gen_results_html_pro_default.py 2>&1 | tee -a "$LOG"
}

log "========================================"
log "pro + default 独立赛道 全量跑分启动"
log "========================================"

BUCKET_2048=(adaptive-rejection-sampler bn-fit-modify break-filter-js-from-html build-cython-ext build-pmars build-pov-ray cancel-async-tasks circuit-fibsqrt cobol-modernization code-from-image configure-git-webserver constraints-scheduling count-dataset-tokens custom-memory-heap-crash db-wal-recovery distribution-search dna-assembly extract-elf feal-differential-cryptanalysis feal-linear-cryptanalysis fix-code-vulnerability fix-git fix-ocaml-gc gcode-to-text git-leak-recovery git-multibranch headless-terminal hf-model-inference kv-store-grpc large-scale-text-editing largest-eigenval llm-inference-batching-scheduler log-summary-date-ranges mailman make-doom-for-mips make-mips-interpreter model-extraction-relu-logits modernize-scientific-stack mteb-retrieve multi-source-data-merger nginx-request-logging openssl-selfsigned-cert password-recovery path-tracing-reverse path-tracing polyglot-c-py polyglot-rust-c prove-plus-comm pypi-server pytorch-model-cli pytorch-model-recovery query-optimize raman-fitting regex-chess regex-log reshard-c4-data sanitize-git-repo schemelike-metacircular-eval sparql-university sqlite-db-truncate sqlite-with-gcov tune-mjcf video-processing vulnerable-secret winning-avg-corewars write-compressor)

BUCKET_4096=(compile-compcert crack-7z-hash dna-insert financial-document-processor install-windows-3.11 merge-diff-arc-agi-task overfull-hbox portfolio-optimization protein-assembly sam-cell-seg train-fasttext)

# qemu-alpine-ssh/qemu-startup 官方镜像是预编译 amd64,Apple Silicon 上经 Rosetta 2 跑会因
# pkey_mprotect(syscall 282)未实现而被杀,--force-build 让 harbor 本地按 arm64 原生构建绕开。
BUCKET_4096_FORCE_BUILD=(qemu-alpine-ssh qemu-startup)

BUCKET_8192=(caffe-cifar-10 filter-js-from-html gpt2-codegolf mcmc-sampling-stan mteb-leaderboard rstan-to-pystan torch-pipeline-parallelism torch-tensor-parallelism)

run_bucket "2048mb" 4 0 "${BUCKET_2048[@]}"
run_bucket "4096mb" 2 0 "${BUCKET_4096[@]}"
run_bucket "4096mb-qemu" 2 1 "${BUCKET_4096_FORCE_BUILD[@]}"
run_bucket "8192mb" 1 0 "${BUCKET_8192[@]}"

log "========================================"
log "pro + default 独立赛道 全量跑分完成"
log "========================================"

cat >> evolution-log-pro-default.md << EOFLOG

## 全量跑分完成 ($(date '+%Y-%m-%d %H:%M'))

87 题(89 题去掉视觉题 chess-best-move/extract-moves-from-video)已跑完,详见
results-pro-default.html / results-pro-default.json。
EOFLOG
