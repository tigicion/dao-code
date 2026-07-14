---
name: terminal-bench-iterate
description: DAO terminal-bench 自进化循环的编排技能——批跑完自动进入下一阶段(体检失败题/修复/复测/下一批或held_out抽查),不用每次重新想"接下来该干嘛"或等用户说"继续"。任何"继续跑迭代""下一批""这批跑完之后呢"类工作,在 evals/terminal-bench/ 下先读这份技能确定当前处在状态机的哪个阶段。
---

# Terminal-Bench 自进化编排

配合 `terminal-bench-debug-evolve`(debug/evolve 的判断纪律)一起用:这份管"流程该往哪走、
并发怎么配",那份管"每一步具体怎么判断根因"。

真正让"批跑完自动继续"生效的机制是 `ScheduleWakeup`——每次巡检收尾时,把下一阶段该做
的事写进下一次 wakeup 的 prompt 里,不是等用户再说一遍"继续"。用户想要完全不用自己
说话就能持续迭代,可以用 `/loop` 触发;不用 `/loop` 也没关系,只要每次都记得排下一次
wakeup 就能做到"批跑完自动触发"。

## 状态机:5 个阶段循环

1. **LAUNCH**(启动批次)
2. **WAIT**(等待完成)
3. **DEBUG**(体检所有失败题,调用 `terminal-bench-debug-evolve`)
4. **EVOLVE**(找到根因就修,可能循环回小型 LAUNCH 做复测)
5. **NEXT**(决定下一轮是正常批次还是 held_out 抽查)

## 判断"现在在哪个阶段"

每次被唤醒(wakeup 触发或收到 task-notification),先做这几件事定位状态,不要凭记忆:

1. `tail -50 evals/terminal-bench/evolution-log.md`——看最后记的是"批次已启动等结果"
   还是"某题已确认修复"还是别的。
2. `docker ps` + 最近 job 目录下的 `reward.txt`/`exception.txt`——批次是不是真的跑完了。
3. `git log --oneline -5`——有没有还没复测验证的修复 commit 挂在那。

## 阶段 1:LAUNCH——启动下一批

1. 从 `split.json` 的 `dev_pool_order` 里,按 `evolution-log.md` 记录的上一批止步位置,
   取下 15 题(到头了从 0 循环,split.json 注释本来就这么设计)。
0. **启动前先 `docker network prune -f`**(不只是 `docker container prune`)——长时间
   连续跑很多批次会堆积大量 docker-compose 起的 per-task 网络,不清理会撞上
   "all predefined address pools have been fully subnetted"(Docker 网络地址池耗尽),
   报错是 `RuntimeError: Docker compose command failed...`,exception.txt 里既不是
   `_handle_sigterm` 也不是 `AgentTimeoutError` 签名(是空/未知签名),容易被误判成
   新的外部杀进程问题——实际上是纯粹的资源堆积,清网络就好,不是 bug。
2. **确认二进制 commit 跟当前 HEAD 一致**(`git log --oneline -1` 对比编译时打印的
   commit hash)。不一致就先 `./agent/build-binaries.sh` 重编——这条踩过坑,别省。
3. **按内存分桶决定并发,不要用同一个 `-n` 糊弄所有题**:
   ```bash
   python3 agent/batch_by_memory.py <这批15个题目名>
   ```
   输出三组(2048MB→`-n 4`、4096MB→`-n 2`、8192MB→`-n 1`),每组单独一条 `harbor run`
   命令,`run_in_background: true`,不要合并成一条。
4. 每条 `harbor run` 都要带 `--ak provider=<当前确认稳定的provider>`、`--env-file .env`、
   `--agent-timeout-multiplier 1`、`--jobs-dir jobs --job-name <批次名+桶名>`。
5. 排 WAIT 阶段的 `ScheduleWakeup`,prompt 里把这轮涉及的所有 job-name 列全,别漏掉
   某个桶。

## 阶段 2:WAIT——等批次跑完

1. 巡检用 `docker ps`/`reward.txt`/`exception.txt`,**不用 `ps aux`**(会把 API key
   明文打进 docker-compose exec 的命令行参数里,已经踩过坑)。
2. `exception.txt` 里 `_handle_sigterm` 签名 → 外部杀进程,清理孤儿容器、重跑该题
   (不算真实结果)。`AgentTimeoutError` 签名 → 自然超时,算真实结果,不重跑。
   **签名是空的/`RuntimeError: Docker compose command failed`/`address pools have been
   fully subnetted`** → 不是外部杀进程也不是超时,是 docker 网络堆积耗尽,`docker network
   prune -f` 清一遍再重跑,不要误判成基础设施故障计数(这个不算进"同一类故障连续3次"
   的停止条件,是纯资源维护,清一次基本不会再犯)。
3. 三个桶都出齐结果(没有新容器在跑、没有排队的)→ 进 DEBUG 阶段。
   没出齐 → 继续排 WAIT 阶段的 wakeup,间隔按批次里最长预算题目的剩余时间估算
   (查 `task_meta.json` 的 `agent_timeout_sec`,不要无脑固定 1200s)。

## 阶段 3:DEBUG——体检所有失败题

对这批**所有**(不设 ≥2 门槛)reward=0 的题,挨个跑 `agent/diagnose_failure.py`,按
`terminal-bench-debug-evolve` 的检查清单走完全部。产出:每题一行"归因+证据"记进
`evolution-log.md`,不写"看起来是任务难度"这种没有排除依据的结论。

## 阶段 4:EVOLVE——找到根因就修

按 `terminal-bench-debug-evolve` 的 Evolve 步骤(预测先行 → TDD → commit → 确认重编 →
复测)。复测算一次**独立的小型 LAUNCH**——只跑被修复涉及的那几题,不用等下一个正常
批次,验证通过后更新这批的最终归因表。可能会循环:复测失败或撞上无关故障 → 回 DEBUG
重新查或干净重跑。

## 阶段 5:决定下一轮跑什么

按顺序检查,命中最上面那条就选它:

1. **距上次 held_out 抽查 ≥ 2 批** → 这一轮跑 held_out 抽查(从 `split.json` 的
   `held_out` 列表选 1-2 道之前没抽过的,正常跑一遍;结果只用来判断"最近的改动有没有
   过拟合到 dev 题",不计入 dev batch 通过率)。
2. 否则 → 回 LAUNCH,取下一批 15 题。

## 停止条件——不要无限跑下去而不吭声

- **每 3-4 轮**(不是每轮)在这轮小结里主动提一句阶段性汇总(过了几批、修了几个真
  bug、当前通过率),不用等用户问,也不用真的停下来等确认——除非踩到下面两条。
- **连续 2 批出现"改坏的题比改好的题多"**(pass→fail 数 > fail→pass 数)→ 停下来,
  不再自动进 LAUNCH,汇报给用户看过再继续。这是"改坏比改好多就停"的纪律,不能被
  自动化流程绕过去。
- **同一类基础设施故障(网络不通/外部杀进程)连续复现 ≥3 次** → 停下来汇报,不要
  无限重跑掩盖过去——这可能是环境本身出了更大的问题,不是偶发噪声。
