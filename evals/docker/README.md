# codeds eval —— 容器镜像(kind:"docker")

重工具链(Java / C++ / 数据科学)的 OSS 评测任务,把 `install` / `fail2pass` / `pass2pass` 跑在容器里,宿主不必装一堆 SDK。每个语言一个基础镜像。

## host-agent + bind-mount 模型

codeds **本体仍在宿主跑**,直接编辑挂载进容器的工作区文件;只有 install/测试命令进容器。runner 把抛弃式临时工作区 `tmp` 以 `-v <tmp>:/work -w /work` 挂进容器:

```
docker run --rm -v <tmp>:/work -w /work <image> bash -lc "<cmd>"
```

这样 agent 用的还是宿主上的 codeds,容器只负责"重环境里跑构建与测试"。

## 怎么 build

在仓库根目录执行(`.` 是构建上下文):

```bash
docker build -f evals/docker/node.Dockerfile      -t codeds-eval/node      .
docker build -f evals/docker/python.Dockerfile    -t codeds-eval/python    .
docker build -f evals/docker/python-ds.Dockerfile -t codeds-eval/python-ds .   # 重镜像
docker build -f evals/docker/java.Dockerfile      -t codeds-eval/java      .
docker build -f evals/docker/cpp.Dockerfile       -t codeds-eval/cpp       .
```

task.json 里 `"image"` 填这个 tag(如 `"image": "codeds-eval/python"`)。

## 网络规则:装依赖联网、跑测试断网

- **install 阶段**:容器联网(`docker run ... <image> bash -lc "<install>"`),拉 npm/pip/maven 依赖。
- **测试阶段**:runner 强制断网并降权:

```bash
docker run --rm --network none --cap-drop=ALL --security-opt no-new-privileges \
  --cpus=2 --memory=4g --pids-limit=512 \
  -v <tmp>:/work -w /work <image> bash -lc "timeout 600 <cmd>"
```

含义:`--network none` 断网(防联网作弊/外泄)、`--cap-drop=ALL` 丢弃所有 Linux capability、`no-new-privileges` 禁提权、`--cpus/--memory/--pids-limit` 限资源防跑飞、命令外再加 `timeout 600` 兜底。

> 推论:测试阶段不能联网,所有依赖必须在 install 阶段进镜像/工作区(如 Java 用 `mvn -o` 离线跑测试前先在线预热 `~/.m2`)。

## 资源限额

| 限制 | 值 | 作用 |
|---|---|---|
| `--cpus` | 2 | 防 CPU 跑飞 |
| `--memory` | 4g | 防内存炸 |
| `--pids-limit` | 512 | 防 fork 炸弹 |
| `timeout` | 600s | 单条测试命令超时 |

数据科学镜像(`python-ds`)较重,按需用;一般 Python 任务用 `python` 即可。

## 复现性与防作弊保证

1. **digest 钉死**(复现):各 Dockerfile 目前用固定 tag(如 `python:3.12-slim`)。生产应改成 `@sha256:...` 摘要钉死,保证镜像逐字节可复现。本环境离线无法核 digest,已在每个 Dockerfile 标注 `TODO`。
2. **测试后注入**(防作弊):PR 带的测试在 base commit(`ref`)上**不存在**,agent 工作区里看不到;runner 在 agent 跑完后才用 `git checkout <fix_ref> -- <test_files>` 注入测试再判定。agent 无从针对测试 reward-hacking。
3. **断网 + 降权 + 限额**(隔离):见上,测试阶段无网络、无特权、有资源上限。

## docker 不可用怎么办

宿主没装 docker(`docker version` 失败)时,runner **跳过** docker-kind 任务并标注 `docker 不可用,跳过`(`⏭️`),不会崩。
