---
name: slide-game-项目-2岁儿童-ipad-滑滑梯游戏
title: Slide Game 项目——需求澄清汇总
type: semantic
importance: 9
uses: 3
confidence: 1
created: 2026-06-29
lastUsed: 2026-06-29
status: active
locked: false
---
用户正在开发一个给2岁儿童玩的 iPad 滑滑梯游戏：SwiftUI + SpriteKit，iOS 16+，横屏模式，XcodeGen 构建。场景布局三层：顶部滑梯名称标签、中央滑梯舞台（SKShapeNode 多层描边：深色外轮廓6pt+面色渐变+高光线+支柱横梁+护栏）、底部角色排队栏（圆形头像等距排列）。交互：点击角色→弹跳→瞬移至滑梯顶部平台→沿滑道滑下（SKAction.follow orientToPath:true）→着陆区弹起→走回排队栏（省略爬梯动画，即点即滑，动画中锁定点击）。滑梯4种通过左右滑动手势切换：直滑梯红色（陡坡→水平缓冲）、J形弯滑梯蓝色（陡→平）、波浪滑梯绿色（2-3波峰）、螺旋滑梯紫色（绕中心柱螺旋下降）。角色8个：卡通角色（粉红）、弟弟角色（蓝）、妈妈角色（橙）、爸爸角色（深绿）、配角甲（浅粉）、配角乙（棕）、配角丙（黄）、配角丁（黄绿）；透明底PNG从StickPNG/CleanPNG下载，缩放至80-100pt存Assets.xcassets。音效4节点用AVAudioPlayer+SoundManager单例预加载：点击（短促弹跳声）、滑行（slide whistle/whoosh，ZapSplat）、着陆（boing弹簧声，SoundDino）、走回（脚步声，Pixabay）。代码结构：Model/SlideTypes.swift（已有，扩展spiral）+CharacterData.swift；Scene/GameScene.swift（状态机idle|animating）+SlideNode.swift（多层绘制）+CharacterNode.swift（SKAction序列封装）；Audio/SoundManager.swift。验收标准8条（滑梯切换/角色栏/点击滑下/路径旋转/路径正确/多层描边/音效/防连点）。项目骨架已有App.swift+ContentView.swift+SlideTypes.swift，GameScene尚未实现。设计规格文档：docs/superpowers/specs/2025-01-20-slide-game-design.md。
