---
name: verify-with-evidence
type: feedback
importance: 8
uses: 0
confidence: 1
created: 2026-06-13
lastUsed: 2026-06-13
status: active
locked: false
---
验证必须基于实际证据（运行命令、读取输出），不能仅凭代码审查或测试通过就声称完成。为什么：用户明确纠正了"读代码认为对"的验证方式，要求独立运行验证命令并确认输出。怎么用：在 verification-before-completion 或任何声称完成前，必须执行验证命令（如运行测试、构建、检查输出文件），并引用实际输出作为完成依据。
