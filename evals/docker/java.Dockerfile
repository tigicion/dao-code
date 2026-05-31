# dao-eval/java —— Java/Maven 工具链评测镜像
#
# 用途:kind:"docker" 任务里的 Java 项目(mvn test 等)。
# 约定:install 阶段联网(mvn 拉依赖);测试阶段 runner 强制 --network none(断网),
#       所以依赖必须在 install 阶段进本地 ~/.m2(可在 install 命令里 mvn -o 预热)。
#       降权 + 限额由 runner 加。
#       dao 本体在宿主跑、改挂载进 /work 的工作区文件(host-agent + bind-mount)。
# 复现:生产应按 digest 钉死(FROM maven:3.9-eclipse-temurin-21@sha256:...);
#       离线无法核 digest,这里先用固定 tag,TODO: 上线前换成 @sha256 摘要。
FROM maven:3.9-eclipse-temurin-21

# JDK + Maven 已在基础镜像;仅补 git(取测试文件/克隆已在宿主做,容器内偶尔需要)
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 非 root 运行(配合 --cap-drop=ALL / no-new-privileges)
RUN useradd --create-home --shell /bin/bash runner
USER runner

WORKDIR /work
