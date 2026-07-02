---
name: dao-diff-render
title: dao TUI diff 渲染走 buildEditHunk + App.tsx matchAll
type: semantic
importance: 6
uses: 1
created: 2026-07-01
lastUsed: 2026-07-01
status: active
locked: false
---
dao 的 edit_file/multi_edit 返回里嵌 ```diff 块(buildEditHunk 生成),App.tsx 的 toolResult 用 matchAll 收集全部 diff 块逐行渲染;加新写工具的 diff 展示要同时接这两处。
