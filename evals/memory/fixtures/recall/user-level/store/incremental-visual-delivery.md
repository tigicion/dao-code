---
name: incremental-visual-delivery
title: 视觉/动画改动必须增量交付，禁止大爆炸式重构
type: feedback
importance: 10
uses: 1
confidence: 1
created: 2026-06-29
lastUsed: 2026-06-29
status: active
locked: false
---
对 SpriteKit 游戏的视觉和动画做改进时，必须逐个小步交付、每步 build+run+截图验证。某 session 一次性重写了多个节点文件（滑梯纹理、角色弹簧动画、背景、粒子特效、场景集成）共 5 个文件，用户反馈'还不如第一版，太难看了'——滑梯方向反了、角色一团黑。根因：没有任何中间视觉 checkpoint。需要更强的执行约束：改一个文件→xcodegen generate→xcodebuild build→simctl install+launch→截图→确认效果后再改下一个；在用户看过并认可前，绝不开下一个文件的改动。
