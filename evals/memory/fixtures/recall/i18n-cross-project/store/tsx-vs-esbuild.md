---
name: tsx-vs-esbuild
title: dao 项目用 esbuild 打包非 tsx 直跑
type: procedural
importance: 5
uses: 1
created: 2026-06-25
lastUsed: 2026-06-29
status: active
origin: dao-code
locked: false
---
用户习惯 tsx 直跑 TypeScript 脚本,但 dao 主项目走 esbuild 打包;临时验证脚本可 tsx,但顶层 await + CJS 输出会报错,验证脚本要写成 async IIFE 或用 import()。
