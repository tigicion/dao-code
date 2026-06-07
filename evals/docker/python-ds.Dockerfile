# codeds-eval/python-ds —— Python 数据科学工具链评测镜像(重镜像)
#
# 用途:kind:"docker" 任务里依赖 numpy/scipy/scikit-learn/pandas 的数据科学项目。
#       预装这些重型包,避免每次 install 都从头编译/下载(慢且测试阶段已断网)。
# 注意:这是重镜像(数百 MB~GB 级),仅给确实需要 numpy 栈的任务用;
#       一般 Python 任务用 python.Dockerfile 即可。
# 约定:install 阶段联网;测试阶段 runner 强制 --network none(断网),并降权 + 限额。
#       codeds 本体在宿主跑、改挂载进 /work 的工作区文件(host-agent + bind-mount)。
# 复现:生产应按 digest 钉死(FROM python:3.12-slim@sha256:... + 固定包版本);
#       离线无法核 digest,这里先用固定 tag,TODO: 上线前换成 @sha256 摘要并钉包版本。
FROM python:3.12-slim

# 系统工具链(编译 wheel 用)放最前,利用 layer 缓存
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates build-essential gfortran \
    && rm -rf /var/lib/apt/lists/*

# 预装数据科学重型包(单独成层,任务代码变了不重装)
RUN pip install --no-cache-dir \
      numpy scipy scikit-learn pandas

# 非 root 运行(配合 --cap-drop=ALL / no-new-privileges)
RUN useradd --create-home --shell /bin/bash runner
USER runner

WORKDIR /work
