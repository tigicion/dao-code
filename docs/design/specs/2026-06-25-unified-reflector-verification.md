# 统一反思器 — 实证记录

> [设计定稿](2026-06-25-unified-reflector-design.md) 的真实模型验证。离线测试全用假模型,本文记录**第一次上真模型**的实测输出,可追溯、可复现。
> 模型 DeepSeek V4(flash/pro),2026-06-25。所有片段为真实运行原样,未润色。

## 1. 孤立件验证(`scripts/verify-reflect.ts`,单次 flash 调用)

构造一段【既打转又被纠正】的对话(反复改 `foo.ts:42` + "以后回复用中文"),看真模型能否产出可解析的 `{onTrack, advisory, memories}`。

实测返回:

```json
{
  "onTrack": false,
  "advisory": "用户反馈修复无效且报错相同，说明当前诊断有误。可能根因不在 foo.ts:42 的判空，而是上游调用或数据源未处理 null。建议先确认报错堆栈完整信息，再定位真正源头，而非反复改同一行。",
  "memories": [
    { "title": "用户要求回复一律用中文", "text": "用户明确要求所有回复使用中文，不得夹杂英文。", "type": "user", "importance": 8, "confidence": 1 }
  ]
}
```

**判读**:`onTrack=false` 正确识别打转+纠正;advisory 精准点出"根因可能不在你以为的那行,别反复改同一处"——正是挑战者意图;记忆抽出。✅ 真模型 → 合法 JSON → 解析 → 过滤,全链路成立。

## 2. 全链路集成验证(真实 `dao` 会话,`DAO_REFLECT_SYNC=1`)

隔离 HOME/cwd,两轮对话(自我介绍 → "以后回复用中文、提交不加 AI 署名,记住")。

`memory-trace.jsonl` 实测:

```jsonc
{"kind":"reflected","ran":true, "onTrack":true,"advisoryInjected":false,"memAdded":0,"memMerged":0,"interval":1}
{"kind":"wrote","type":"feedback","merged":false}                 // ← 主动路径 memory_write(模型自己记)
{"kind":"reflected","ran":false,"onTrack":true,"advisoryInjected":false,"memAdded":0,"memMerged":0,"interval":2}
```

落盘的记忆文件(`~/.dao/memory/回复用中文-提交不加ai署名.md`):

```markdown
---
name: 回复用中文-提交不加ai署名
title: 回复用中文、提交不加AI署名
type: feedback
importance: 8
---
用户要求：1) 回复一律用中文；2) 提交代码一律不要加 AI 署名（如 "Co-authored-by: AI" 之类）。
```

**判读**:
- 接线全活:`reflected` 事件落盘、`title`/`slug(title)` 文件名/feedback 路由(→ user 层)全对。
- **自适应节奏工作**:turn1 安静 → `interval` 1→2 → turn2 被**跳过**(`ran:false`)。
- **双路互补**(意外但有价值的发现):turn2 那条纠正,反思器因节奏回退被跳过,但**主动路径**(模型自己 `memory_write`,带 title)接住了。反之亦然——两者都没动时,下次反思器跑时补抽,只迟不丢。

## 3. demo 对照实测(有记忆 vs 无记忆)

存入偏好(`type: feedback`):「回答务必极简,以 ✅ 加粗一句话结论开头」。同一问题「用 setTimeout 做搜索框防抖,可靠吗?」:

| | 首行 | 体量 |
|---|---|---|
| **有记忆** | `✅ 可靠，但光有防抖不够。` | **6 行 / 288 字符** |
| **无记忆**(`DAO_NO_MEMORY=1`) | `` `setTimeout` 做防抖在"减少请求次数"这个层面可靠，但… `` | **58 行 / 1389 字符** |

跨会话偏好被自动召回 → 6 行 vs 58 行的体量差。gif:[`docs/assets/demo-reflect.gif`](../../assets/demo-reflect.gif)(逐帧核过:存储证明 / 极简✅ / 长篇对照 / 字幕干净)。

## 4. 观察到的 prompt 小瑕疵(待收紧,非 bug)

- **user/feedback 分类不稳**:同样"回复用中文"的偏好,孤立件 flash 判 `user`,集成会话 pro 判 `feedback`(更准)。提示词里两者区分可再强调。
- **source 噪音**:孤立件里模型给 `source:"当前对话"`,而 source 应只填代码出处。提示词可强调"无代码出处则省略"。

两者都不影响功能(偏好确实记下、分类落在合理层),属可调项。

## 复现

```bash
DEEPSEEK_API_KEY=... npx tsx scripts/verify-reflect.ts   # §1 孤立件
vhs scripts/demo-reflect.tape                            # §3 demo(key 放被 gitignore 的 .env)
# §2 集成:隔离 HOME + cwd 跑真实 dao 多轮,DAO_REFLECT_SYNC=1 防后台与退出竞争,查 memory-trace.jsonl
```
