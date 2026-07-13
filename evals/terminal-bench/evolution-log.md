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
