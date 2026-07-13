"""Harbor 装机型 agent 适配器,把 DAO CODE 接进 Terminal-Bench 2.1(经 Harbor 跑)。

取代 dao_code_agent.py(旧,基于已废弃的原生 terminal-bench harness + npm 发布版):
本适配器从**源码交叉编译的二进制**装机,而不是 npm 装最新发布版——这不是随手的实现选择,
是自进化闭环能成立的前提:候选改动要在合并前先跑分验证,而 npm 发布是慢周期(见
evals/terminal-bench/README.md 的发版流程),等不起也不该用来测未发布的候选改动。

关键设计:
- 按容器架构(x86_64/aarch64)选对应二进制,装机时 `uname -m` 探测,原生跑不吃 QEMU 模拟开销。
- DAO 自身输出 + `.dao/`(session 全量轨迹,含 reasoning_content)写进
  `EnvironmentPaths.agent_dir` 下——这个目录 harbor 在**超时路径也会下载**
  (harbor/trial/trial.py 的 AgentTimeoutError except 分支同样调用 _maybe_download_logs),
  用一个独立于主 exec 协程的后台快照循环兜底:主调用被 harbor 的 timeout 取消时,
  容器内快照循环仍在跑,保证超时那一刻前 <=20s 的 `.dao` 快照已经落在 agent_dir 里,
  不会像最初那版(输出重定向到 /tmp)一样超时后什么诊断信息都拿不到。
"""

import shlex

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

# 按容器架构选二进制,构建方式见 ./build-binaries.sh(输出到 agent/bin/,已 gitignore)。
# 路径相对 harbor run 的调用目录(约定在 evals/terminal-bench/ 下跑,见 README)。
_BIN_DIR = "agent/bin"
DAO_BINARY_LOCAL_PATHS = {
    "x86_64": f"{_BIN_DIR}/dao-linux-x64",
    "aarch64": f"{_BIN_DIR}/dao-linux-arm64",
}
DAO_BINARY_REMOTE_PATH = "/usr/local/bin/dao"

_AGENT_DIR = EnvironmentPaths.agent_dir.as_posix()
_SNAPSHOT_DIR = f"{_AGENT_DIR}/dao_snapshot"
_STDOUT_FILE = f"{_AGENT_DIR}/dao_stdout.txt"


class DaoAgent(BaseInstalledAgent):
    """把 DAO CODE 的 headless 一次性调用(argvPrompt 模式)包成 Harbor 装机型 agent。"""

    @staticmethod
    def name() -> str:
        return "dao-code"

    def get_version_command(self) -> str | None:
        return f"{DAO_BINARY_REMOTE_PATH} --version"

    async def install(self, environment: BaseEnvironment) -> None:
        arch_result = await self.exec_as_root(environment, command="uname -m")
        arch = arch_result.stdout.strip()
        local_path = DAO_BINARY_LOCAL_PATHS.get(arch)
        if not local_path:
            raise RuntimeError(f"没有为容器架构 '{arch}' 交叉编译过 DAO 二进制,先跑 build-binaries.sh")
        await environment.upload_file(local_path, DAO_BINARY_REMOTE_PATH)
        await self.exec_as_root(
            environment,
            command=f"chmod +x {shlex.quote(DAO_BINARY_REMOTE_PATH)} && mkdir -p {shlex.quote(_AGENT_DIR)}",
        )

    @with_prompt_template
    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        api_key = self._get_env("DEEPSEEK_API_KEY") or ""
        if not api_key:
            raise ValueError("DEEPSEEK_API_KEY not set (pass via --env-file or --ae)")

        escaped_instruction = shlex.quote(instruction)
        env = {"DAO_NO_NOTIFY": "1", "DEEPSEEK_API_KEY": api_key}

        # 后台快照循环(独立进程,不受主 exec 被 harbor 取消的影响):每 20s 把工作区的
        # .dao 复制进 agent_dir,超时时至少有最近一次快照能被 harbor 的日志下载路径带出来。
        await self.exec_as_agent(
            environment,
            command=(
                f"mkdir -p {shlex.quote(_SNAPSHOT_DIR)} && "
                f"nohup bash -c 'while true; do "
                f"cp -r ./.dao {shlex.quote(_SNAPSHOT_DIR)}/ 2>/dev/null; sleep 20; "
                f"done' > /dev/null 2>&1 & disown"
            ),
        )

        await self.exec_as_agent(
            environment,
            command=(
                f"{DAO_BINARY_REMOTE_PATH} --yolo "
                f'--api-key "$DEEPSEEK_API_KEY" --provider deepseek '
                f"{escaped_instruction} "
                f"> {shlex.quote(_STDOUT_FILE)} 2>&1"
            ),
            env=env,
        )

        # 正常收尾路径:再快照一次拿到最终态(超时路径靠上面的后台循环兜底,这里不会执行到)。
        await self.exec_as_agent(
            environment,
            command=f"cp -r ./.dao {shlex.quote(_SNAPSHOT_DIR)}/ 2>/dev/null || true",
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        # token/cost 统计留空——过没过由 harbor verifier 单独判定;agent_dir 下的
        # dao_stdout.txt + dao_snapshot/.dao/ 已经被 harbor 的 _maybe_download_logs 带到本地了,
        # 复盘蒸馏步骤直接读 jobs/<job>/<task>/agent/ 即可,不需要这里再做什么。
        pass
