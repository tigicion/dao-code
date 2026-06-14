# 安全策略 / Security Policy

dao 是一个会**读写文件、执行 shell 命令**的终端 agent,安全是第一位的。本文说明如何上报漏洞,以及 dao 自身的安全模型。

## 支持的版本

| 版本 | 是否维护 |
|------|---------|
| 0.1.x | ✅ |

发布前(0.x)我们只维护最新一个 minor。

## 上报漏洞

**请不要在公开 issue 里上报安全漏洞。**

请使用 GitHub 的 **私密漏洞上报(Private Vulnerability Reporting)**:
仓库页 → **Security** 标签 → **Report a vulnerability**。

> 维护者注:需先在仓库 **Settings → Code security and analysis → Private vulnerability reporting** 开启该功能。

请尽量包含:复现步骤、影响范围、相关版本/环境、以及(可选)修复建议。我们会尽快确认并在修复后致谢(除非你要求匿名)。

## dao 的安全模型(便于评估风险面)

dao 默认开启的防护:
- **权限门**:写/执行/网络类工具默认需审批;5 种模式 `default / acceptEdits / auto / plan / bypassPermissions(yolo)`。
- **敏感目标 bypass-immune**:`.ssh / .aws / .git / 凭据 / shell rc / /etc / .dao/config.json` 等的写/执行,**任何模式(含 yolo)都强制确认**。
- **危险命令拦截**:`rm -rf /`、fork bomb、`curl|sh`、提权、写裸盘等命中黑名单 → 强制人工(`auto` 下不可被分类器放行)。
- **Unicode 消毒**:命令/路径里的同形字、零宽、null 字节 → 视为可疑、走审批。
- **秘密扫描**:API key/私钥等不写进持久记忆、不入蒸馏。
- **子进程 env 脱敏**:`spawn` 的命令拿不到 `DEEPSEEK_API_KEY` 等敏感环境变量。
- **SSRF 防护**:`fetch_url` 拦截内网/环回/云元数据端点。
- **目录信任**:未信任目录默认**不加载**其 `.dao/settings.json` 与 `hooks.json`(防 clone 来的恶意仓库自动执行);`dao trust` 显式信任。
- **审计日志**:写/执行/网络工具裁决记入 `.dao/audit.log`。

可选(opt-in)加固:
- **OS 沙箱**:`DAO_SANDBOX=1`(macOS Seatbelt / Linux bubblewrap),工作区可写、其余只读;`DAO_SANDBOX_NO_NET=1` 断网。
- **系统钥匙串**:`DAO_USE_KEYCHAIN=1` 把 key 存进 Keychain/libsecret 而非明文。

## 使用建议
- 在**可信工作目录**里运行;对不熟悉的仓库先 `dao trust` 前审视。
- `auto`/`yolo` 自动放行更省事但风险更高——重要环境建议配合 `DAO_SANDBOX=1`。
- API key 用环境变量或 `DAO_USE_KEYCHAIN=1`,避免明文 `~/.dao/config.json`。
