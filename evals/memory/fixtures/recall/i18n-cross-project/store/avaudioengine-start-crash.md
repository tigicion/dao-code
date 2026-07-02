---
name: avaudioengine-start-crash
title: AVAudioEngine 模拟器启动崩溃防护
type: procedural
importance: 7
uses: 2
created: 2026-06-15
lastUsed: 2026-06-20
status: active
origin: kids-game
locked: false
---
iOS 模拟器上 AVAudioEngine.start() 会因底层 audio HAL 不可用崩溃;必须先用 AVAudioSession 设 category 并 setActive(true),再 start,且用 try? 兜住;真机不受影响。
