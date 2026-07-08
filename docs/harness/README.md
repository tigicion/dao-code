# 框架(Harness)组件现状清单

> 最后核对:2026-07-07,commit `33df233`

这个文件夹是 dao-code 自身框架(harness)六大可编辑组件的**当前实现快照**,不是设计文档——`docs/architecture/` 和 `docs/design/` 里的文档记录"为什么这么设计"及历史演进,这里只记录"现在代码里到底是什么样"。每个文件对应一个组件,发现和代码不一致时以代码为准,并顺手更新这里的文件。

灵感来自 arXiv 2604.25850《Agentic Harness Engineering》一文对编码智能体框架的拆解方式(系统提示词/工具/中间件/技能/子智能体配置/长期记忆),但 dao-code 没有字面意义的"middleware"模块,详见 [middleware.md](middleware.md) 里的映射说明。

## 组件清单

- [system-prompt.md](system-prompt.md) —— 系统提示词:`src/prompt/system_prompt.ts`
- [tools.md](tools.md) —— 工具:`src/tools/`
- [middleware.md](middleware.md) —— 中间件(横切执行控制,dao-code 里分散在 hooks/loop/compact/reflect/turn_health 等模块)
- [skills.md](skills.md) —— 技能:`src/skills/`
- [subagents.md](subagents.md) —— 子智能体配置:`src/agent/agent_defs.ts`、`bundled_agents.ts`、`subagent.ts`
- [memory.md](memory.md) —— 长期记忆:`src/memory/`

## 维护约定

- 每份文件顶部标注"最后核对"的日期 + commit hash,作为下次核对时"距离上次隔了多久/多少改动"的参照,不代表内容仍然准确。
- 涉及行号的引用会随代码变动漂移,只作为定位线索,以实际文件内容为准。
- 改了对应模块的实现且影响到这里描述的行为时,顺手更新对应文件而不是另开文档。

## wire/ —— 实际发给 LLM 接口的最终内容

以上六份文件描述"组件怎么实现",`wire/` 目录是**真实拼装出的最终 wire 内容**——即真正进 `messages`/`tools` 参数的字节,而不是转述:

- `system-prompt.wire.md` —— `messages[0]` 的完整 system 消息全文(BODY + 子代理类型表 + skill 目录 + 记忆段落,全部拼好)
- `tools.wire.json` —— 发给 API 的 `tools` 参数原文(OpenAI function-calling 格式的 24 个工具 JSON Schema)
- `memory.wire.md` / `skills.wire.md` / `subagents.wire.md` —— 分别是嵌入在 system prompt 里对应小节的原文(方便单看,不用去长文件里找)
- `middleware.wire.md` —— 中间件在运行中追加到对话尾部的消息模板原文(诊断回灌/进度提醒/审视者-纠偏者 advisory/压缩摘要等),动态部分用 `<...>` 标出

**由 `npm run debug:harness-wire`(`scripts/dump-harness-wire.ts`)重新生成**——它用本仓库真实的 `.dao/memory`、你的 `~/.dao/memory`/`~/.dao/knowledge`/`~/.dao/skills` 跑一遍 `index.ts` 里组装 system prompt 的同一段逻辑。

**⚠️ `memory.wire.md` / `system-prompt.wire.md` 已加进 `.gitignore`,不要提交到公开仓库**——两者都包含你 `~/.dao` 里真实的跨项目个人记忆(system prompt 把 `{memory}` 段也拼了进去),只留在本地用于核对"到底发了什么给模型",改代码或记忆变化后重跑脚本刷新即可。`tools.wire.json`/`skills.wire.md`/`subagents.wire.md`/`middleware.wire.md` 不含个人数据,正常入库、随仓库演进。
