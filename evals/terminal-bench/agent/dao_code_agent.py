"""dao-code 的 terminal-bench 自定义 agent 适配器。

安装式(AbstractInstalledAgent):在任务容器里装 Node + `npm i -g dao-code`,
用 headless 一次性模式(`dao -p "<instruction>" --api-key ... --provider deepseek`)
把整条 instruction 一次性交给它,由 dao 自己在容器内完成"读环境→动手→验证→收尾"全过程。

API key 走 terminal-bench 的 `_env` 机制注入(docker exec 写入,不经过被录像的 tmux
会话),运行命令里只写 `"$DEEPSEEK_API_KEY"` 这个变量引用,不会把明文 key 录进
asciinema 转录——和其余装好的 agent(aider/opencode 等)同一套模式。
"""

import os
import shlex
from pathlib import Path

from terminal_bench.agents.installed_agents.abstract_installed_agent import (
    AbstractInstalledAgent,
)
from terminal_bench.terminal.models import TerminalCommand


class DaoCodeAgent(AbstractInstalledAgent):
    @staticmethod
    def name() -> str:
        return "dao-code"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # npm 包版本;默认最新(latest),--agent-kwarg version=0.3.0 可锁定。
        self._version = kwargs.get("version") or "latest"

    @property
    def _env(self) -> dict[str, str]:
        key = os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("DS_API_KEY")
        if not key:
            raise ValueError(
                "需要设置 DEEPSEEK_API_KEY(或 DS_API_KEY)环境变量才能跑 dao-code agent"
            )
        # 容器里没人能回应审批交互提示;不设这个会在第一个 write/exec 工具调用上原地卡死到超时。
        return {"DEEPSEEK_API_KEY": key, "DAO_AUTO_APPROVE": "1"}

    @property
    def _install_agent_script_path(self) -> Path:
        return self._get_templated_script_path("dao-code-setup.sh.j2")

    def _run_agent_commands(self, instruction: str) -> list[TerminalCommand]:
        escaped = shlex.quote(instruction)
        return [
            TerminalCommand(
                # $DEEPSEEK_API_KEY 是变量引用,shell 静默展开、不会被录进转录里的输入文本。
                command=(
                    f'dao -p {escaped} --api-key "$DEEPSEEK_API_KEY" '
                    f"--provider deepseek"
                ),
                min_timeout_sec=0.0,
                max_timeout_sec=float("inf"),
                block=True,
                append_enter=True,
            ),
        ]
