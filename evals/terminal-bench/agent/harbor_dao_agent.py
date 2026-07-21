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

# 默认二进制目录,构建方式见 ./build-binaries.sh(BIN_DIR=... 可指到别的目录,已 gitignore)。
# 路径相对 harbor run 的调用目录(约定在 evals/terminal-bench/ 下跑,见 README)。
_DEFAULT_BIN_DIR = "agent/bin"
DAO_BINARY_REMOTE_PATH = "/usr/local/bin/dao"

_AGENT_DIR = EnvironmentPaths.agent_dir.as_posix()
_SNAPSHOT_DIR = f"{_AGENT_DIR}/dao_snapshot"
_STDOUT_FILE = f"{_AGENT_DIR}/dao_stdout.txt"

# provider → .env 里约定的 key 变量名(与 DAO 自身 src/config/profiles.ts 的 Provider 并集一致)。
# 没列出的 provider 兜底 "<PROVIDER>_API_KEY",不必每加一个 provider 都改这张表。
_API_KEY_ENV = {
    "deepseek": "DEEPSEEK_API_KEY",
    "volcengine": "VOLCENGINE_API_KEY",
    "qianfan": "QIANFAN_API_KEY",
}


class DaoAgent(BaseInstalledAgent):
    """把 DAO CODE 的 headless 一次性调用(argvPrompt 模式)包成 Harbor 装机型 agent。

    bin_dir(可选构造参数,经 `--ak bin_dir=<路径>` 传入):要装机的二进制所在目录,
    默认 agent/bin。跑 A/B(比如某个基线 commit vs 当前 HEAD)时,分别把两个 commit
    的二进制编到不同目录,同一份 agent 代码指过去即可,不用为每次对比复制一份 agent 类。

    provider(可选构造参数,经 `--ak provider=qianfan` 传入):走哪个 provider,默认
    deepseek(向后兼容)。对应的 API key 从 .env 里 _API_KEY_ENV 那张表查到的变量名读取
    (qianfan → QIANFAN_API_KEY),不是每次都硬编码 DEEPSEEK_API_KEY——所有 provider
    共用同一套 DAO 二进制/评测流程,换 provider 不需要改这份 agent 代码本身。
    """

    @staticmethod
    def name() -> str:
        return "dao-code"

    def __init__(self, *args, bin_dir: str = _DEFAULT_BIN_DIR, provider: str = "deepseek", model: str = "", **kwargs):
        super().__init__(*args, **kwargs)
        self._bin_dir = bin_dir
        self._provider = provider
        self._model = model
        self._api_key_env = _API_KEY_ENV.get(provider, f"{provider.upper()}_API_KEY")

    def get_version_command(self) -> str | None:
        return f"{DAO_BINARY_REMOTE_PATH} --version"

    async def install(self, environment: BaseEnvironment) -> None:
        arch_result = await self.exec_as_root(environment, command="uname -m")
        arch = arch_result.stdout.strip()
        binary_names = {"x86_64": "dao-linux-x64", "aarch64": "dao-linux-arm64"}
        binary_name = binary_names.get(arch)
        if not binary_name:
            raise RuntimeError(f"没有为容器架构 '{arch}' 交叉编译过 DAO 二进制,先跑 build-binaries.sh")
        local_path = f"{self._bin_dir}/{binary_name}"
        await environment.upload_file(local_path, DAO_BINARY_REMOTE_PATH)
        await self.exec_as_root(
            environment,
            command=f"chmod +x {shlex.quote(DAO_BINARY_REMOTE_PATH)} && mkdir -p {shlex.quote(_AGENT_DIR)}",
        )

    @with_prompt_template
    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        api_key = self._get_env(self._api_key_env) or ""
        if not api_key:
            raise ValueError(f"{self._api_key_env} not set (pass via --env-file or --ae)")

        escaped_instruction = shlex.quote(instruction)
        env = {"DAO_NO_NOTIFY": "1", self._api_key_env: api_key}

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
                f"{DAO_BINARY_REMOTE_PATH} --yolo --eval "
                f'--api-key "${self._api_key_env}" --provider {shlex.quote(self._provider)} '
                + (f'--model {shlex.quote(self._model)} ' if self._model else '')
                + f"{escaped_instruction} "
                + f"> {shlex.quote(_STDOUT_FILE)} 2>&1"
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
