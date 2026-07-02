---
name: swiftui-gesture-scrollview
title: SwiftUI 手势与 ScrollView 触摸冲突
type: procedural
importance: 6
uses: 1
created: 2026-06-16
lastUsed: 2026-06-18
status: active
origin: kids-game
locked: false
---
SwiftUI 中 gesture 会独占触摸、阻止 ScrollView 滚动;需用 simultaneousGesture 或把 DragGesture 的 minimumDistance 调大,让滚动优先。
