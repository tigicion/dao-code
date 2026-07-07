#!/usr/bin/env python3
# 建 + 启动一个 SWE-bench instance 容器,复用官方 harness 的 build_env_images/build_container
# (和真正判定阶段用的同一套镜像/环境),把 DAO 放进去干活。只负责"建容器",不做判定——
# 判定仍交给官方 swebench.harness.run_evaluation(见 evals/swebench/README 里的下一步命令)。
#
# 用法:python3 container_helper.py <instance_id> <run_id>
# 输出(stdout 最后一行):{"container": "<容器名>", "workdir": "/testbed"}

import json
import logging
import sys
from pathlib import Path

import docker

from swebench.harness.utils import load_swebench_dataset
from swebench.harness.test_spec.test_spec import make_test_spec
from swebench.harness.docker_build import build_env_images, build_container, setup_logger


def main():
    instance_id, run_id = sys.argv[1], sys.argv[2]

    instances = load_swebench_dataset("SWE-bench/SWE-bench_Verified", "test", [instance_id])
    if not instances:
        print(json.dumps({"error": f"instance {instance_id} 不在数据集里"}))
        sys.exit(1)
    instance = instances[0]

    client = docker.from_env()
    # namespace=None ⇔ CLI 的 --namespace ''(本地建镜像);tag 显式传,不依赖各函数不一致的默认值。
    test_spec = make_test_spec(instance, namespace=None, base_image_tag="latest",
                                env_image_tag="latest", instance_image_tag="latest")

    # 环境镜像(装依赖那层,重活在这——串行建,不并发,规避之前撞见的内存竞争)。
    # 注:build_env_images 的 instance_image_tag/env_image_tag 默认值是 None(与
    # make_test_spec 默认的 "latest" 不一致)——CLI 因 argparse 总显式填 "latest" 而不踩这坑,
    # 直接调 Python API 必须显式传,否则内部 get_test_specs_from_dataset 位置参数错位断言失败。
    _, failed = build_env_images(client, [instance], max_workers=1, namespace=None,
                                  instance_image_tag="latest", env_image_tag="latest")
    if failed:
        # 立刻报清楚(常见根因:conda-forge/pip 源瞬时网络失败,重试通常就好),
        # 别让后续 build_container 报个"镜像不存在"的二手错误、掩盖真实原因。
        print(json.dumps({"error": f"环境镜像建失败(常见于瞬时网络问题,可重试):{failed}"}))
        sys.exit(1)

    log_dir = Path(__file__).parent / "runs" / instance_id
    log_dir.mkdir(parents=True, exist_ok=True)
    logger = setup_logger(instance_id, log_dir / "build_container.log")

    container = build_container(test_spec, client, run_id, logger, nocache=False)
    container.start()

    print(json.dumps({"container": container.name, "workdir": "/testbed"}))


if __name__ == "__main__":
    main()
