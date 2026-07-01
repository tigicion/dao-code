---
name: credentials-in-tool
title: 用户偏好凭证管理闭环在工具内，不依赖环境变量
type: user
importance: 9
uses: 1
confidence: 0.95
created: 2026-06-29
lastUsed: 2026-06-29
source: (redacted)
status: active
locked: false
---
用户明确要求去掉所有环境变量 API key 支持，只保留 profile 系统（~/.dao/config.json + 钥匙串）+ headless 模式的 --api-key CLI 参数。交互模式只走 profile（/account 可见全貌、/login 可切换），headless 用 dao -p "..." --api-key + --provider。为什么：env key 造成"功能不闭环"——选择器里看不到、换 key 无效、静默覆盖 profile 难以排查。
