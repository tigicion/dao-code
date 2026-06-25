# 案例研究:自主构建一个 SQL 数据库引擎(长任务稳健 + 成本)

> 2026-06-25 · dao v0.1.20(当前源码现编二进制)

`dao --goal` 全自主、零人工干预,用 Rust 标准库从零写出一个**功能完善的 SQL 数据库引擎**
(2760 行 / 6 模块),并用它写真实分析报表。引擎在 **3000+ 条它从没见过的随机 SQL 上与真 SQLite 逐行一致**;
整个过程 **76 分钟、661 次 API 调用、多次穿越自动压缩仍跑到全绿**。总成本 **¥10.61**,缓存命中 **93.0%**。

## 任务与验收(为什么不可糊弄)

任务:用 Rust 标准库实现一个 SQL 引擎(禁止链接 sqlite),并写两个真实分析脚本。

验收用**差分测试**对照**真正的 SQLite**(Python 内置 `sqlite3`):同一脚本在 dao 的引擎与 SQLite 上
逐字节比对输出。用例 = 手写 golden(子查询/EXISTS/事务/集合运算/CASE/自连接…)+ 错误用例 + 真实 demo +
**数百个随机生成的脚本**(随机数据 + 随机查询,每个 SELECT 都 `ORDER BY` 定序)。SQLite 是独立权威,
随机程序无法被预先硬编码 —— "对"是真的对。

| 验证 | 用例数 | 结果 |
|---|---|---|
| 原种子 | 421 | **421/421** |
| 新种子 ×2(各 1500 随机) | 1521 ×2 | **全过** |
| 负对照(`cat` 只回显) | — | 0 通过(验收有牙) |

覆盖面:DDL、`INSERT/UPDATE/DELETE`、事务(`BEGIN/COMMIT/ROLLBACK`)、`INNER/LEFT/CROSS JOIN` 与自连接、
`WHERE`(`LIKE`/`BETWEEN`/`IN 列表`/`IN 子查询`/`EXISTS`/标量子查询/`AND OR NOT`)、`GROUP BY`+`HAVING`、
聚合(含 `COUNT(DISTINCT)`)、`CASE WHEN`、字符串函数(`UPPER/LOWER/LENGTH/SUBSTR/||`)、
集合运算(`UNION/UNION ALL/INTERSECT/EXCEPT`)、`ORDER BY`(多键/序号/ASC|DESC)、`LIMIT ... OFFSET`、
列别名,以及完整的 **NULL 三值逻辑**。

dao 用这引擎写的真实报表片段(输出与 SQLite 逐字节一致):

```sql
SELECT dept.dname, COUNT(*), SUM(emp.salary)
  FROM emp JOIN dept ON emp.dept = dept.id GROUP BY dept.dname ORDER BY dept.dname;
SELECT emp.name, proj.pname,
  CASE WHEN proj.lead IS NOT NULL THEN 'active' ELSE 'unassigned' END AS status
  FROM emp LEFT JOIN proj ON proj.lead = emp.id ORDER BY emp.name, proj.pname;
SELECT name, salary FROM emp
  WHERE dept IN (SELECT id FROM dept WHERE dname IN ('eng','sales')) ORDER BY name;
```

## 长任务稳健(机制真的触发并被穿越)

- **661 次调用(425 次主推理)、76 分钟**,全程 `--goal` 自主,零人工干预。
- **自动压缩多次触发**:`[已压缩对话:~137,957 → ~6,985 tok]`、`[~117,082 → ~7,901 tok]`;
  上下文轨迹 `15k→77k→103k→134k→166k→51k→89k→116k→147k→167k`(多次回落),峰值 171k。
- **关键**:每次压缩重置部分上下文后,任务仍正确推进 —— 最终穿过压缩跑到 421/421,并自主定位+修复了
  最后 4 个硬 bug(相关子查询列解析、`NULL != x` 三值逻辑、`GROUP BY` 后列投影解析)。

## 成本

| 指标 | 值 |
|---|---|
| 总成本 | **¥10.61**(≈ $1.5) |
| 输入 token | 42,179,250(缓存命中 39,244,032) |
| 输出 token | 223,816 |
| 缓存命中率 | **93.0%** |

成本低的核心是吃满 DeepSeek 前缀缓存(命中价 ≈ 未命中的 1/10):dao 请求前缀逐字节稳定,93% 输入走缓存价。

## 测量方法说明(诚实优先)

- **缓存命中**两路交叉验证:dao 自报 93.0% == 一个透明日志代理在 wire 层独立统计的 92.9%(代理记录每次请求体 + usage)。
- **关于压缩窗口**:dao 默认上下文窗口 = **1,000,000**(对齐 DeepSeek 真实窗口,见 `src/index.ts`)。
  本案例用 `DAO_CONTEXT_WINDOW=200000` 把窗口压到 200k,才使压缩在 ~140-170k 被观测到。
  **若用默认 1M,这个任务(峰值 171k)不会触发压缩** —— 它装得下,这本身说明 dao 上下文不膨胀。
  要在真实 1M 默认下自然触发压缩,需要峰值逼近 1M 的超大任务。本案例的"压缩稳健"是在 200k 窗口下演示的。
- **运行方式**:一次性命令行 `dao --goal "<指令>"`(非交互)。该路径下反思层关闭,因此本案例展示的是
  "自主连续推进 + 压缩 + 持续正确",不含反思器纠偏。

## 复现配方

```bash
# 1) 准备一个带 SQL 差分验收的工作区(reference = python sqlite3,fuzzer 生成随机脚本对照)
# 2) 现编当前源码二进制:npm run bundle:install
# 3) 跑:
DEEPSEEK_API_KEY=... DAO_CONTEXT_WINDOW=200000 \
  dao --goal "按 DAO.md 实现 SQL 引擎 + 写 demos/,跑通 python3 tests/sql_diff.py"
# 4) 独立复核(换种子防过拟合):
SQL_SEED=99999 SQL_FUZZ=1500 python3 tests/sql_diff.py
```
