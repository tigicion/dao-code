# 统一反思器与记忆系统

> 回合末**一个 fork** 同时做"反思进展 + 抽取记忆";记忆靠 **title + LLM** 召回/合并,不再用相似度。
> 设计定稿见 [`docs/design/specs/2026-06-25-unified-reflector-design.md`](../design/specs/2026-06-25-unified-reflector-design.md)。

## 有记忆 vs 无记忆

![reflector demo](../assets/demo-reflect.gif)

同一个问题("用 setTimeout 做搜索框防抖,可靠吗?"),上个会话教过它「回答务必极简、先给 ✅ 结论」:

- **有记忆**:`✅ 可靠,但光有防抖不够` —— 6 行,先结论。
- **无记忆**(`DAO_NO_MEMORY=1`):58 行长篇铺陈。

跨会话偏好被**自动召回**,不用每次重说。

## 反思器(回合末)

每个用户回合结束,后台跑一个 fork(复用主对话前缀热缓存,命中 ~95%),返回:

```jsonc
{ "onTrack": true,           // 是否在轨
  "advisory": null,          // 有问题(打转/跑偏/攻错层)才给;onTrack=true 必为 null
  "memories": [ /* 抽到的耐久事实,含 mergeInto 合并意图 */ ] }
```

- **advisory 产出门控**:在轨就不注入 —— 消灭"在轨,继续"噪音;有问题才 append-only 注入下一回合(缓存安全)。
- **记忆**:经精确键去重 + `mergeInto` 语义合并落盘。
- **自适应节奏**:默认每回合;连续"安静"(在轨且无新记忆)回退至多 3 回合,一有产出立刻回到每回合。
- **轮内卡住/漂移**仍由 `assessTurn`(工具轮级:连续失败→挑战者、长任务每 3 轮→纠偏者)细粒度兜——反思器够不着长自主回合的轮内问题。

## 记忆存储/召回

- **一文件一记忆** + `title`(≤1 行概要,既展示又派生文件名)+ `text`(完整事实)。
- **去重**=精确键(同 `slug(title)` 即同一条 → 覆盖);**语义合并**交反思器 `mergeInto`;**召回**=注入层给 title 索引 + `memory_read` 关键词 AND 匹配。**不再用字符相似度**。
- 注入:高价值整句常驻 + 长尾给 title 索引;记忆总数 < 50 时全注入、跳索引层(最简)。

## 配置 / 观测

| 环境变量 | 作用 |
|---|---|
| `DAO_REFLECT_MAX_INTERVAL` | 自适应节奏上限(默认 3) |
| `DAO_REFLECT_EVERY=1` | 固定每回合(关自适应) |
| `DAO_NO_MEMORY=1` | 禁注入 + 禁反思器记忆(demo 对照) |
| `DAO_DEBUG_REFLECT=1` | 每回合 stderr 打 `[reflect] onTrack/mem/interval` |
| `DAO_REFLECT_SYNC=1` | 反思同步完成再继续(测试/录制) |

- **`/audit reflect`**:汇总 N 回合里跑/跳几次、advisory 几次、记忆新增/合并、当前节奏。

## 复现 demo

```bash
# 隔离环境(key 放被 gitignore 的 .env,别贴进任何会被提交的文件)
vhs scripts/demo-reflect.tape   # 输出 docs/assets/demo-reflect.gif
```

> demo 用真模型录制,模型非确定;脚本里 `Sleep` 需按模型时延调整(回合慢于 Sleep 会被截断)。
