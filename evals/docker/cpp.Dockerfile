# dao-eval/cpp —— C/C++ 工具链评测镜像
#
# 用途:kind:"docker" 任务里的 C/C++ 项目(g++ / cmake / make 构建与测试)。
# 约定:install 阶段联网(拉依赖/configure);测试阶段 runner 强制 --network none(断网),
#       并降权 + 限额。
#       dao 本体在宿主跑、改挂载进 /work 的工作区文件(host-agent + bind-mount)。
# 复现:生产应按 digest 钉死(FROM debian:bookworm-slim@sha256:...);
#       离线无法核 digest,这里先用固定 tag,TODO: 上线前换成 @sha256 摘要。
FROM debian:bookworm-slim

# 工具链放最前,利用 layer 缓存
RUN apt-get update && apt-get install -y --no-install-recommends \
      g++ cmake make git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 非 root 运行(配合 --cap-drop=ALL / no-new-privileges)
RUN useradd --create-home --shell /bin/bash runner
USER runner

WORKDIR /work
