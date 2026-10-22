# 模型清单与能力参数

最后核对：2026-10-22。维护入口为 src/config/profiles.ts；模型 ID、上下文窗口、图片输入与已核实的输出上限由同一条记录提供。命令校验、模型选择器、图片提示与客户端预算均使用这些记录。

## 官方依据

| 渠道 | 来源 | 本次校准 |
|---|---|---|
| DeepSeek | [API 模型名](https://api-docs.deepseek.com/zh-cn/) | 官方 Flash 改用 deepseek-flash；旧别名仍可路由，不作为新的选择项 |
| 火山 Coding Plan | [套餐模型](https://docs.volcengine.com/docs/ark/coding-plan-personal-plan-overview?lang=zh)、[工具能力配置](https://docs.volcengine.com/docs/ark/coding-plan-personal-ai-opencode?lang=en)、[下线公告](https://docs.volcengine.com/docs/ark/coding-plan-personal-model-deprecation?lang=zh)、[上线记录](https://docs.volcengine.com/docs/ark/coding-plan-personal-model-release?lang=zh) | 更新 Seed 2.1、Kimi K3/K2.8、GLM 5.3 与 V4.1 Flash/Economy；补齐 Seed 图片能力；不再推荐已下线或已开始退出的旧版本 |
| 千帆 Token Plan | [套餐可调用 ID](https://cloud.baidu.com/doc/qianfan/s/Dmrabu8b6)、[模型参数表](https://cloud.baidu.com/doc/qianfan/s/rmh4stp0j) | 补齐 V4.1 Flash-1017、Pro-0813、Flash-0731、GLM-5.3-Flash，保留官方仍列出的 GLM-5.2/5.1 |
| 智谱 Coding Plan | [套餐模型](https://docs.bigmodel.cn/cn/coding-plan/overview)、[GLM-5.3](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3) | 两档 GLM-5.3/Flash；主模型纯文本，Flash 支持图片 |
| Anthropic | [模型总览](https://platform.claude.com/docs/en/models/overview) | Opus/Sonnet/Haiku 5.5、Fable 5.1，均支持图片与 1M 窗口 |
| OpenAI | [模型表](https://developers.openai.com/api/docs/models)、[GPT-6 迁移约束](https://developers.openai.com/api/docs/guides/latest-model)、[Responses 迁移](https://developers.openai.com/api/docs/guides/migrate-to-responses) | Astra、Sol 6.1、Luna 三档，1,050,000 窗口，128,000 输出上限；保留 GPT-5 |

## 渠道、旧账户和动态路由

- 同名模型在不同渠道可有不同窗口：千帆 GLM-5.2 按官方 1M，GLM-5.1 按 198K；旧自定义网关的 GLM-5.2 仍维持已验证的 200K。官方端点查渠道记录，自定义端点回退兼容表，未知模型仍按既有 1M 行为。手动 /context-window 和 DAO_CONTEXT_WINDOW 覆盖继续优先。
- 千帆 kimi-k2.6 与 ernie-5.1 为既有账户兼容项，不宣称属于当前 Token Plan 推荐列表。能力窗口按千帆模型表校准为 256K / 128K；Kimi 已标注即将下线。是否仍能调用取决于账户授权。
- ark-code-latest 由控制台路由，不能假设永远指向 1M 模型。采用官方工具配置的保守值 256K / 32K；图片输入按工具配置启用，若路由目标不支持图片仍会由服务端拒绝。明确目标时应选具体 ID，或手动覆盖窗口。
- 文档使用 1M 而未给精确数字的条目按 1,000,000 保守处理；明确 1024K 的 Seed 2.1/Evolving 按 1,024,000。
- 辅助模型在 DeepSeek 官方选择 deepseek-flash，在火山/千帆选择 deepseek-v4.1-flash。自定义网关完整模型名保持继承。

## GPT-6 协议

官方 OpenAI GPT-6 工具调用走 Responses API；自定义网关保持原有 Chat 协议。适配层复用现有客户端的取消、重试、超时与非流式兜底，转换图片和工具结果，并在会话检查点保存、回传加密推理项。输出预算受模型上限约束，凭证探针也走对应协议。

清单核对不等于对每个账户逐一发付费请求。协议与回合流程使用假服务验收，供应商授权、网关路由和套餐可用范围以实际账户为准。
