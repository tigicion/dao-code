---
name: verify-with-evidence
title: 验收必须真跑起来
type: feedback
importance: 9
uses: 4
confidence: 0.9
created: 2026-06-20
lastUsed: 2026-07-01
status: active
locked: false
---
用户反对"typecheck/build/test 过就声称完成",要求写完代码真正跑起来验证。为什么:通过静态检查不等于运行时行为正确。怎么用:改完后实际启动跑一遍(缺 key 等跑不通就如实说明没跑),别只报静态检查绿。
