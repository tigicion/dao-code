---
name: canvasapp-贴纸图片位于-canvasapp-resources
type: semantic
importance: 9
uses: 2
confidence: 1
created: 2026-06-16
lastUsed: 2026-06-18
source: (redacted)
status: active
locked: false
---
CanvasApp 贴纸图片加载使用 Bundle.main.path(forResource:ofType:inDirectory:) + UIImage(contentsOfFile:) 替代 SKSpriteNode(imageNamed:) 和 UIImage(named:)，因为 SpriteKit 对 bundle 子目录中的图片查找不可靠
