---
name: cli-highlight-plaintext
title: cli-highlight 返回纯文本需独立着色
type: procedural
importance: 7
uses: 3
created: 2026-06-28
lastUsed: 2026-07-01
status: active
origin: dao-code
locked: false
---
cli-highlight 的 highlight() 在 Ink/终端上下文返回纯文本、不带 ANSI 码,diff 行靠整行单色区分等于没高亮;应把 +/-/空 符号前缀拆成独立 Text 用 ANSI 色码着色,代码正文走默认色。
