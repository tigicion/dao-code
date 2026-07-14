# Terminal-Bench 2.1 harness

跑 DAO 在 Terminal-Bench 2.1(89 题,4 easy / 55 medium / 30 hard,`task_meta.json` 有完整
难度+类别标注)上的表现,以及基于它的**基准驱动自进化**(见下)。

用 [Harbor](https://www.harborframework.com/)(Terminal-Bench 2.0/2.1 官方 harness 的现行框架)。
`agent/dao_code_agent.py` 是 2026-07-08 用已废弃的原生 `terminal-bench` harness 跑的旧脚本,
只留作历史记录(结果见 `runs/`),不再维护——现在统一用 `agent/harbor_dao_agent.py`。

## 为什么从源码交叉编译二进制,不用 npm 发布版

自进化闭环要验证的是**未发布的候选改动**——等 npm 发版周期跑不起来,也测不到真正想测的东西。
`agent/build-binaries.sh` 从当前 git HEAD 编两个架构的二进制(容器可能是 x86_64 也可能是
aarch64,按 `uname -m` 自动选,避免 QEMU 模拟拖慢跑分)。**每次要测的源码变了,先重新跑一次
这个脚本**,不然测的是上次编的旧二进制。

## 环境准备

```bash
python3 -m venv evals/terminal-bench/venv
source evals/terminal-bench/venv/bin/activate
pip install harbor

# API key(从本机钥匙串取,不明文过手 —— 见下方"安全"一节)
security find-generic-password -a dao/default -s dao-api-key -w \
  | (echo -n "DEEPSEEK_API_KEY=" && cat) > evals/terminal-bench/.env
```

## 换 provider(比如千帆 Coding Plan)

`harbor_dao_agent.py` 的 `DaoAgent` 支持 `provider` 构造参数(默认 `deepseek`),经
`--ak provider=<名字>` 传入;对应的 key 变量名从脚本里的 `_API_KEY_ENV` 表查(千帆是
`QIANFAN_API_KEY`),没列出的 provider 兜底 `<PROVIDER>_API_KEY`。`.env` 里加一行对应的
key 即可,同一份 `.env` 文件可以同时放多个 provider 的 key(harbor 只会读用到的那个):

```bash
security find-generic-password -a dao/<你的千帆 profile 名> -s dao-api-key -w \
  | (echo -n "QIANFAN_API_KEY=" && cat) >> evals/terminal-bench/.env
```

## 跑

```bash
cd evals/terminal-bench
./agent/build-binaries.sh          # 每次测新源码前先编

source venv/bin/activate
harbor run -d terminal-bench/terminal-bench-2-1 \
  --agent-import-path agent.harbor_dao_agent:DaoAgent \
  --ak provider=qianfan \           # 省略则默认 deepseek(向后兼容)
  --env-file .env \
  --agent-timeout-multiplier 4 \    # 900s 基线放宽到 3600s(约 1 小时),见下方"超时"一节
  -i "<task-name>" [-i "<task-name>" ...] \  # 不给就是全量 89 题,真跑之前务必先用 -i 圈定范围
  -n 2 -y --jobs-dir jobs --job-name <名字>
```

结果在 `jobs/<job-name>/`:每题一个目录,`verifier/reward.txt`(0/1)、`verifier/test-stdout.txt`
(pytest 完整输出)、`trial.log`(DAO 的调用记录)、**`agent/dao_stdout.txt` + `agent/dao_snapshot/.dao/`**
(DAO 自己的完整会话轨迹——含 reasoning_content、逐工具调用耗时/成败,复盘蒸馏步骤读这个)。

## 并发与内存分桶

不要把高内存题目和低内存题目混进同一个 `-n` 里跑——单一并发数要么为了迁就少数高内存题目
被迫压得很低、拖慢大多数题目的迭代速度,要么为了让大多数题目跑得快而对高内存题目并发过高、
撑爆 Docker VM 内存(实测总预算约 12.5GB)引入偶发 OOM 这类新的不稳定源。

`task_meta.json` 每题有 `memory_mb`(89 题里 2048/4096/8192MB 三档,2048MB 占大多数)。
按内存分桶、每桶配不同并发数,用 `agent/batch_by_memory.py` 自动分组(阈值:每桶
`-n × 桶内存上限 ≈ 8GB`,留 ~4.5GB 给 host/harbor 自身开销,不是精确计算,是留够余量):

```bash
python3 agent/batch_by_memory.py task1 task2 task3 ...
# 输出三组 -i 列表,分别带各自建议的 -n(2048MB→4、4096MB→2、8192MB→1),
# 拼进对应的三条 harbor run 命令分别提交,而不是塞进同一条命令的同一个 -n。
```

## 超时:已放宽到可配置,默认建议 4x(≈1 小时)

`task_meta.json` 里每题的 `agent_timeout_sec` 大多是 900s(15 分钟),少数 1800/2400s。
`--agent-timeout-multiplier 4` 把这个放宽到约 1 小时,给 DAO 更多空间把正在做的事做完,
而不是被基准原始设定的紧时限打断。

**之前的坑**:老版本把 DAO 输出重定向到容器内 `/tmp/`,一旦真的触发超时,harbor 会强制取消
调用协程,`/tmp/` 里的内容从来没机会被下载出来,导致超时案例完全没有诊断信息(是卡住了还是
只是在正常推进但慢)。已修:`harbor_dao_agent.py` 现在把 DAO 输出直接写进 harbor 的
`agent_dir`(harbor 在**超时路径也会下载**这个目录,见 `harbor/trial/trial.py` 的
`AgentTimeoutError` except 分支),另起一个独立于主调用协程的**后台快照循环**每 20 秒把
`.dao/` 复制进去——即便主调用被强制取消,快照循环作为容器内独立进程不受影响,超时那一刻前
最多 20 秒的完整轨迹都能捞出来。下次真撞上超时,看 `dao_stdout.txt` 和 `dao_snapshot/.dao/sessions/*/`
就知道它当时在干什么。

## 任务划分:`split.json`

```jsonc
{
  "held_out": [...],          // 固定 10 题,永不进 dev batch,只用于定期抽查泛化(防过拟合)
  "dev_pool_order": [...],    // 剩余 79 题的固定顺序,按 dev_batch_size(15)顺序切片
  "dev_batch_size": 15
}
```

按难度分层抽样(种子 20260713,可复现),`held_out` 和 `dev_pool` 按当前 89 题的
易:中:难 = 4:55:30 比例抽取。**`held_out` 里的题任何时候都不能被用来决定要不要采纳一个改动**——
只用来定期抽查"改动是不是在拿 dev 题的具体细节过拟合"。

## 基准驱动自进化(设计,尚未实现执行脚本)

受 arXiv 2604.25850(Agentic Harness Engineering)启发,但按 DAO 的实际规模大幅缩水——
论文用 GPT-5.4 xhigh + E2B + 96 并发跑 32 小时,这里没有那个预算,保留的是它的三层可观测性
**结构**,不是它的算力规模。

三层:
1. **组件可观测**:DAO 的 harness 组件本来就是文件(`src/tools/*.ts`、系统提示词、
   `.dao/memory/*.md`、skill、hooks.json)——git 版本控制,天然满足。**DAO 现有 hooks 机制
   可以充当"middleware"那一层,但要慎用**:hooks 是最容易写成"对着某道具体题的字符串特判"
   的一层,过拟合风险最高,门槛应该比工具实现/记忆层的改动更高(见下)。
2. **经验可观测**:每题的 `agent/dao_stdout.txt` + `agent/dao_snapshot/.dao/sessions/*/state.json`
   (完整轨迹,含推理链)+ harbor 的 `verifier/test-stdout.txt`,喂给一个"debugger"子代理,
   产出每题根因报告,再按**失败模式归类**(不是按单题)汇总。
3. **决策可观测**:每次改动前写一份预测清单(根因、改在哪层、预计修哪些题、可能连带弄坏哪些题),
   落一个 git commit,下一轮真实结果核对预测,不达预期就 revert。

**防过拟合的具体门槛**(这是这次设计跟论文原版最大的不同,论文自己都说"regression blindness"
是最大弱点):
- 一个改动必须能引用 **≥2 道题**共享同一失败模式才够格立案,单题的怪癖不算(hooks 层改动
  提高到 ≥3 道题,因为最容易过拟合)。
- 系统提示词层面的改动单独最没用(论文消融实验实测 −2.3pp),优先在工具实现/长期记忆层找答案。
- 每轮记录哪些题 fail→pass、哪些 pass→fail;某轮改坏的比改好的多,停下来人工看,不管改动
  自己怎么宣称"这次应该没问题"。
- `held_out` 定期抽查(初期计划每 3~4 轮抽一次)。
- 每轮改动落在独立分支/worktree,产出 diff + 预测清单当审阅材料,人工点头才合进 master。

迭代节奏:初期用 dev batch 15 题左右一轮,快速迭代;规模和门槛后续可调。

## 安全

跑分脚本里绝不能出现 API key 明文——`docker compose exec -e KEY=value` 这种写法会把
key 写进进程 argv,本机任何人 `ps aux` 都能看到(已踩过一次坑)。`.env` 文件 + harbor 的
`--env-file` 是目前用的方式,key 只在容器内的环境变量里,不进 CLI 参数、不进日志。
