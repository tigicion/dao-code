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
