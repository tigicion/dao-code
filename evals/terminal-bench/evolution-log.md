# DAO 基准驱动自进化——迭代日志

设计见 `README.md` 的"基准驱动自进化"一节。这份文件记每一轮:证据、根因、改在哪层、
预测影响、验证结果。改动不达预期就在这里记下来、代码层面 revert,不是悄悄略过。

---

## 迭代 0(2026-07-13,人工深挖,非自动蒸馏)

**起因**:A/B 对比(baseline a568a1c vs HEAD)+ 手动深挖 kv-store-grpc/pypi-server/torch-tensor-parallelism。

1. **exec_shell 后台进程不持久化**(`c9b450e`):pipe stdio → SIGPIPE。改成落文件 + unref()。
2. **DAO 退出时无条件清杀后台进程**(`2977479`):headless 一次性调用不该清,交互模式该清。
3. **无 TTY 强制审批卡死**(`35958c7`):mailman 撞见,改成无 TTY 直接 deny。

验证:kv-store-grpc 的 `test_real_grpc_server_running` 从失败变通过。

---

## 迭代 1(进行中)

dev batch(15 题,`split.json.dev_pool_order[0:15]`):
sanitize-git-repo, pytorch-model-recovery, write-compressor, sparql-university,
feal-linear-cryptanalysis, mailman, kv-store-grpc, dna-insert, headless-terminal,
regex-log, build-cython-ext, gcode-to-text, fix-ocaml-gc, db-wal-recovery, cobol-modernization

第一轮结果(修复 exec_shell/退出清理之后,`--agent-timeout-multiplier 2`,修 stdin 审批之前):
9 过 5 未过(db-wal-recovery, dna-insert, gcode-to-text, regex-log, mailman 挂起)。

mailman 挂起 → 定位到迭代 0 的第 3 个 bug,已修复,待复测。

### 4 个真实失败的蒸馏结果(子代理只读分析,证据见各自 session state.json + verifier/test-stdout.txt)

| 任务 | 根因 | 是否 harness 缺陷 | 立案状态 |
|---|---|---|---|
| gcode-to-text | 缺"渲染成图再视觉识别"的能力,纯能力缺口 | 否 | 不追加改动(子代理明确建议不牵强归因) |
| dna-insert | 引物设计题在 1bp缺失+40bp插入的歧义 junction 上,DAO 的臂切分假设和 grader 的规范重建不是同一组序列;是合法但不同的切分 | 否 | 不追加改动(子代理明确建议不牵强归因) |
| db-wal-recovery | 检查 WAL 文件前就用 `sqlite3 main.db` 直接打开——SQLite 打开 WAL 模式库会自动 checkpoint/丢弃可疑 WAL,第一步操作就把唯一不可再生证据销毁了,后 50+ 步徒劳补救、最终编造数据交卷 | 弱相关(操作不可逆数据前没先备份的纪律缺失,系统提示词层面最贴近但杠杆弱) | **候选,n=1,未达 ≥2 题门槛,记录观察** |
| regex-log | 正则本身是对的(子代理独立用官方测试用例复核过,应该 PASS)。DAO 为自测装 python3,`apt-get install -y -qq python3` 设了 60s 超时,被 exec_shell 强杀在 apt 事务中途,dpkg 留在 interrupted 态;这个损坏后来连累验收阶段自己的 `apt-get install curl`(装 uv 用)失败,pytest 从未执行,正确答案记 0 分 | **是,工具实现层**(exec_shell 超时对包管理器事务的强杀无回滚/无警示) | **候选,n=1,机制通用+后果严重(正确答案变 0 分),未达 ≥2 题门槛但重点观察,后续批次一旦复现立即处理** |

结论:这轮蒸馏没有改动达到立案门槛,不硬凑。继续跑 dev batch,专门留意上面两个候选模式是否复现。

### mailman 复测(验证迭代 0 的审批卡死修复)

复测结果:reward 0,但这次是干净的 `AgentTimeoutError`(整 3600s 后正常终止),不再是无限期卡死
(之前卡了 2 小时+,连 harbor 自己的超时强制取消都没能救回来)。全程 0 次触发"需要批准",
514 行输出显示一直在真实推进 postfix+mailman3+LMTP 路由配置。**修复确认生效**——mailman
现在的失败原因是"任务复杂、3600s 预算不够"这种正常类别,不再是 bug。

**iteration 1 最终:15 题里,9 过、2 个候选模式(n=1,观察中)、2 个纯能力/领域难度不追加改动、
1 题(mailman)超时未完成但不再是 bug。**

---

## 基础设施事故(2026-07-14 01:01,与代码改动无关)

iteration 2 的 15 题 rollout 跑到一半,所有 docker 容器(`caffe-cifar-10`、`circuit-fibsqrt`)
同一秒被 SIGKILL(exit 137),harbor 主进程也没了,这批没跑出任何结果。查了 `caffeinate`(已有
3 个实例在跑、系统层面 sleep 已被阻止)、系统睡眠日志(最近 20 分钟无 entering-sleep/wake 记录)、
Docker 崩溃日志、内存压力/jetsam 日志、磁盘空间(471GB 可用,不是问题)——都没找到确定性根因。

不确定是不是 Docker Desktop 自己的 VM 生命周期管理(比如资源节省模式)在长时间无交互式终端操作
时把 VM 收了,没能在设置文件里找到直接证据。没有再深挖,采取实用主义应对:
- 并发从 `-n 2` 降到 `-n 1`,降低单次爆炸半径
- 清了一批停止状态的容器(`docker container prune`,回收 2.5GB)
- 后续巡检间隔缩短,更快发现类似情况并自动重跑,而不是被动等完成通知(这次要等整批彻底死透
  才会收到通知,中间浪费的时间比预期长)

这条记录留给用户看——不是我改的代码有问题,是跑分基础设施本身在长时间无人值守时不够可靠,
值得知道。

**追加(01:31)**:降到 `-n 2` 重跑,`caffe-cifar-10` 这次真跑完了(reward=1,真实结果),但
`circuit-fibsqrt` 又被杀(这次只死一个,不是两个同时死,跟第一次的模式不一样)。注意到一个
可能的规律:两次被杀都发生在我插入"巡检检查"Bash 调用之后不久;唯一一次跑满整小时、正常
超时收尾的(mailman 复测)中途完全没有任何手动检查动作。不确定是不是巧合,但值得一试——
下一轮重跑不再中途插入任何检查,纯粹等待自然完成通知,验证这个假设。

**追加(01:34)**:假设被推翻——这次完全没插入任何巡检动作,重跑仍然被杀,而且比之前更快
(只跑了约 3 分钟,之前是 2 小时→25 分钟→3 分钟,一次比一次快)。用 `docker events` 挖到了
真正的信号模式:两个容器几乎同时收到 `signal=15`(SIGTERM)、不到 1 秒后又收到 `signal=9`
(SIGKILL)——这是优雅关闭紧接强杀的模式,是 harbor 自己响应"被中止"时的清理逻辑(`stop()`
先 docker stop 再强杀),**不是** OOM killer 或系统睡眠那种直接强杀。说明真正的信号源头是
我起的后台 Bash 任务本身被外部终止了,不是 Docker/系统层面的问题——但具体是什么终止的、
为什么一次比一次快,没能定位到确定原因(不在我能直接查的日志范围内)。

应对:不再纠结根因,换策略——从大批次一次性提交改成**一次只跑一题**,每题独立一次
`harbor run` 调用,降低单次被杀的损失半径(丢一题比丢一整批 14 题损失小得多)。

**追加(02:04)**:单题(`circuit-fibsqrt`)也照样被杀,存活约 30 分钟。`exception.txt` 给了
确定性证据:`harbor/cli/jobs.py:282 _handle_sigterm: raise KeyboardInterrupt`——harbor 自己
的 SIGTERM 处理器被触发,说明确实有外部信号在直接杀 harbor 这个 Python 进程本身。不是
Docker/系统层面的问题,是这个环境本身在长时间后台任务生命周期管理上的不稳定,具体机制超出
我能直接排查的范围。

存活时间没有规律(2小时/25分钟/3分钟/30分钟),但目前看单任务在原生时限(不放大)内偶尔能
在被杀之前完成。务实调整:超时倍数从 2x 降回 1x(题目原生时限),用"更大概率活着跑完"换
"给更宽裕的时间但大概率被杀掉"。继续一题一题跑。

### 单题模式下的进展(dev batch 剩余 14 题,一题一题跑,1x 倍数)

| 任务 | 结果 |
|---|---|
| circuit-fibsqrt | 连续 4 次被外部信号杀,从未真正跑完过 |
| largest-eigenval | 0(正常 900s 超时,非外部杀) |
| password-recovery | 第一次被杀,重跑 ✅ 1 |
| constraints-scheduling | ✅ 1 |
| count-dataset-tokens | ❌ 0(token 数算错,63841 vs 期望 79586,像是分词方法选错,待蒸馏) |
| hf-model-inference | ✅ 1 |
| sqlite-with-gcov | ✅ 1 |
| multi-source-data-merger | ✅ 1 |
| qemu-startup | 第一次被杀,重跑后 ❌ 0(expect 脚本登录 QEMU VM 卡在密码提示,没配对登录方式,待蒸馏) |
| financial-document-processor | ✅ 1 |
| protein-assembly | 第一次被杀,重跑后 ❌ 0(融合蛋白结构域顺序不对,领域难度,待蒸馏) |
| bn-fit-modify | ✅ 1 |
| video-processing | 第一次被杀,重跑后 ❌ 0(真实跑了 24 分钟,非外部杀,待蒸馏) |
| reshard-c4-data | 第一次被杀,重跑后 ✅ 1 |

被外部信号杀掉的任务不计入失败统计(不是真实结果),需要重跑到拿到真结果为止。
`circuit-fibsqrt` 重试到第 7 次才拿到真实结果(前 6 次全部被外部信号杀)——这题是这批里
推理量最大的(数字电路状态机设计,轨迹里全是大段长文本推理),真实耗时显著长于其它题,
猜测是"耗时越长、撞上外部随机杀信号的概率越高"这个统计效应的极端案例,不是这题本身有
特殊毛病。

### iteration 2 dev batch 最终结果(15/15 全部拿到真实结果)

| 任务 | 结果 |
|---|---|
| caffe-cifar-10 | ✅ 1 |
| largest-eigenval | ❌ 0 |
| password-recovery | ✅ 1 |
| constraints-scheduling | ✅ 1 |
| count-dataset-tokens | ❌ 0(token 数算错) |
| hf-model-inference | ✅ 1 |
| sqlite-with-gcov | ✅ 1 |
| multi-source-data-merger | ✅ 1 |
| qemu-startup | ❌ 0(QEMU 登录卡在密码提示) |
| financial-document-processor | ✅ 1 |
| protein-assembly | ❌ 0(融合蛋白结构域顺序错) |
| bn-fit-modify | ✅ 1 |
| video-processing | ❌ 0 |
| reshard-c4-data | ✅ 1 |
| circuit-fibsqrt | ✅ 1(第 7 次重试) |

**10 过 5 未过。** 接下来蒸馏这 5 个真实失败(largest-eigenval, count-dataset-tokens,
qemu-startup, protein-assembly, video-processing),看是否有跨题的可立案模式。

### 5 个失败的蒸馏结果

| 任务 | 根因 | 是否 harness 缺陷 |
|---|---|---|
| video-processing | 纯 CV 算法泛化问题,只在唯一样本(example_video)上手调参数,换视频直接崩;24 分钟真实尝试+逐帧自测,过程扎实 | 否,不牵强归因 |
| largest-eigenval | 纯任务难度——n≤10 要击败 LAPACK 本身已经很难,DAO 推理链正确地穷举否决了每条真实路径,900s 内没做完;唯一次要观察:全程未在超时前保底提交一个 best-effort 候选 | 否,但"临界预算保底提交"是个值得记的次要观察 |
| count-dataset-tokens | 把"deepseek tokens"窄化成只算 reasoning 字段;**讽刺点:后来自己把 reasoning+solution 合并总数算出来过,但没有回头拿去更新已经写好的答案** | 弱相关(收尾没有用上自己已经算出的更正信息) |
| protein-assembly | 顺序其实是对的,但违背"必须完全匹配 PDB API FASTA"这条硬约束,自作主张删掉了 His-tag/TEV/GPGS;**`verify_done` 只是复述意图打勾,从没真的把成品跟可机械核验的 PDB 真值 diff 过** | **是** |
| qemu-startup | QEMU 服务真的活着(证明退出清理/后台持久化那两个 commit 生效了,不是同一类 bug 的另一种表现),但自己反复 telnet 探测**全部明确返回失败/超时**,依然判定完成收尾 | **是,而且证据最直接** |

### 立案:"完成判定没有真正锚定在已获得的实际证据上"

四个任务(算上迭代 0 深挖过的 torch-tensor-parallelism 是第五个)、四个完全不同的领域
(PyTorch/数据处理/分子生物学/系统虚拟化),共享同一个行为模式的不同变体:

- torch-tensor-parallelism:环境缺工具,没验证就凭"代码结构看起来对"交了
- count-dataset-tokens:已经算出更正后的正确值,但没用它更新最终答案
- protein-assembly:`verify_done` 只复述意图、没有真的 diff 可核验的真值
- **qemu-startup:自己验证了,拿到明确失败信号,依然收尾**(证据最直接、最难辩解)

跨两轮、跨领域,稳稳超过 ≥2 题门槛。**改动**:强化 `verify_done` 工具描述——加一条具体规则:
"如果你已经自己跑过检查、结果是失败/超时/不匹配,这个负面结果本身就是明确信号,不能因为
'已经很晚/改了很多次/其它部分都对'就当没看见收尾;拿到负面结果意味着还没做完,该继续修
或如实说明卡在哪,不是重新描述一遍意图就当验证过了。"低风险改动(纯工具描述,不碰行为逻辑)。

已提交,typecheck + 全量测试(167 文件/1106 用例)全绿。这个改动的效果没法像 kv-store-grpc
那次一样直接单题复测验证(这是个跨情境的行为纪律,不是某个具体机制 bug),要等后续迭代
持续观察"declare done 但自己刚拿到负面结果"这类情况是否减少。

### 复测 protein-assembly,发现比预期更根本的问题

用带新改动的二进制重跑 protein-assembly:reward 仍是 0。查轨迹发现**这次 `verify_done`
一次都没被调用过**(132 条消息里零次)——模型直接自己写了个总结表格宣布"设计完成、满足
所有要求",压根没走到这个工具。

这说明我这次改的东西没起到应有的效果,不是因为措辞不够狠,而是**根本没被触发**——问题
比"调用了但没听劝"更前置:是"这类非典型编码任务(分子生物学序列设计,不是写代码跑测试
的常规循环)模型可能压根没意识到该调用 verify_done"。这是个新的、更深的候选模式,需要
设计"怎么让 verify_done 更可靠地被调用"(可能涉及系统提示词或更强的机制,风险层级更高),
不适合现在(凌晨,时间有限)仓促决定,留给下一轮专门处理。

### held-out 抽查(防过拟合)

用带今晚全部改动的二进制,抽了 2 道从未进过任何 dev batch 的 held-out 题:
- `prove-plus-comm`:✅ 1
- `openssl-selfsigned-cert`:❌ 0(5/6 子测试过,`check_cert.py` 用了 `cryptography` 库
  没装到验收阶段能用的地方,单独的近似 miss,不是今晚改动引入的新问题)

没有看到"改动导致 held-out 题变差"的迹象——今晚这几个改动(exec_shell 后台持久化、
退出清理按场景区分、无 TTY 审批 fail-closed、verify_done 负面结果规则)看起来是干净的
增量修复,没有在 dev 题上过拟合到伤害泛化能力。

---

## 迭代 3(2026-07-14,用户在线,非自动)

代码基线:commit `7631356`(含今天新增的 `isReadOnlyShellCommand` 分号/devnull 修复、
agent 工具 trust-but-verify、todo_write 全勾提醒),已用 `build-binaries.sh` 重新编译。

dev batch(15 题,`split.json.dev_pool_order[30:45]`):
train-fasttext, merge-diff-arc-agi-task, polyglot-rust-c, mteb-retrieve, pypi-server,
fix-code-vulnerability, cancel-async-tasks, modernize-scientific-stack, crack-7z-hash,
filter-js-from-html, custom-memory-heap-crash, overfull-hbox, qemu-alpine-ssh,
compile-compcert, vulnerable-secret

### 环境笔记
- venv 目录(gitignore)不知何时丢失,重新 `python3 -m venv venv && pip install harbor`,
  装到的是更新版本(0.6.1),任务名过滤参数需要加 `terminal-bench/` 前缀
  (如 `-i "terminal-bench/train-fasttext"`),不带前缀会报 `No tasks matched`。
- 启动前清理了上次会话遗留的孤儿容器(1 个仍在跑的 `video-processing`、8 个
  exited 容器,回收 2GB)。

### train-fasttext:同一个 harbor SIGTERM 问题这次白天也复现了
第一次(`-i train-fasttext`,不带前缀)因为任务名过滤格式问题直接报错,不算尝试。
第二次(`-r2`,带前缀)容器正常起来跑了 34 分钟,`harbor` 主进程自己被外部信号杀掉——
`exception.txt` 里是同样的签名(`harbor/cli/jobs.py:282 _handle_sigterm: raise
KeyboardInterrupt`),容器本身没被杀、变成孤儿(`docker events` 确认容器无 kill/die,
只有 harbor host 进程消失)。清理孤儿容器后重跑(`-r3`)。
第三次干净跑完,自然 `AgentTimeoutError`(1h2m35s,`agent_timeout_sec=3600 × 1x`),
拿到真实结果 ❌ 0——不是这次基础设施问题导致的假失败。

**结论**:overnight 那次诊断的"harbor 自身进程被外部信号杀,不是 Docker/系统层面问题"
这个结论,今天白天用户在线时段又复现了一次(不是只在无人值守时段发生),排除了"只在
凌晨/长时间无交互时才触发"这个假设。具体外部信号源头依然没能定位,继续用"一题一题跑、
撞上就清孤儿容器重跑"的策略兜底。

**安全笔记**:巡检过程中一次 `ps aux | grep harbor` 意外把 docker-compose exec 命令行里的
`DEEPSEEK_API_KEY` 明文打进了工具输出(harbor 自己的 `-e KEY=value` 写法导致,README 已经
记过这个反模式,这次是撞在被动巡检上,不是我们自己脚本写的)。已提醒用户轮换 key,之后
巡检改用 `docker ps`/`docker events --filter` 精确到容器名,不再用 `ps aux`。

### train-fasttext 结果

| 任务 | 结果 |
|---|---|
| train-fasttext | ❌ 0(自然超时 1h2m35s,最好配置 0.6102 vs 要求 0.62,近距离未达标) |

