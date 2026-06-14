# 维护者待办 / Maintainer setup

代码层面已就绪;以下是只能在 GitHub 网页/本地手动完成的事(按优先级)。

## 必做(发布前)
- [ ] **开启私密漏洞上报**:仓库 → Settings → Code security and analysis → 勾选 *Private vulnerability reporting*。(SECURITY.md 与 issue 模板已指向 `…/security/advisories/new`)
- [ ] **录演示 gif/asciinema**:太极开屏 + 一段对话流,存 `docs/demo.gif`,然后取消 README 顶部那行图片注释。TUI 项目第一印象最吃这个。

## 建议
- [ ] **开 Discussions**:Settings → Features → 勾选 Discussions(issue 模板的"提问/讨论"链接指向它)。
- [ ] **加 repo topics**:如 `ai-agent` `coding-agent` `deepseek` `tui` `cli` `llm` `terminal`(仓库主页右侧齿轮)。
- [ ] **标几个 `good first issue` / `help wanted`**,方便新人切入。

## 发布 npm(你已选"计划发布")
- [ ] 确认 `package.json` 的 `version`、`name`(`dao-code`)无冲突:`npm view dao-code version`。
- [ ] 登录:`npm login`。
- [ ] 发布:`npm publish`(`prepublishOnly` 会先 `npm run build`;`publishConfig.access=public` 已配)。
- [ ] 发布后,P3 的"启动更新检查"会自动查 npm registry 的最新版(无需改代码)。
- [ ] (可选)给 release 打 tag,让 `release.yml` 跑。

## 备注
- 安全模型见 `SECURITY.md`;贡献流程见 `CONTRIBUTING.md`;变更记录见 `CHANGELOG.md`。
- 这些是一次性设置,做完可删本文件或留作记录。
