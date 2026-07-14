# 千帆 Token Plan provider — 设计定稿

> 给 DAO 接百度千帆 Token Plan(个人版):新增 `qianfan` provider。**关键事实**:千帆 Token Plan 个人版的模型列表里含 `deepseek-v4-pro`/`deepseek-v4-flash`,串与 DAO 现用**完全一致**(与 `volcengine` 子项目同款结论)。因此复用 `volcengine` 已验证的最小改动模式:扩 provider 枚举/DEFAULTS、按 provider 选校验探针、onboarding 加一项。**不引入模型映射/分档表**。

定稿日期 2026-07-14。参考先例:`docs/design/specs/2026-06-28-volcengine-coding-plan-provider-design.md`(同款 coding-plan provider,已实现并验收)。

---

## 0. 一句话

新增 `qianfan` provider(OpenAI 兼容,base `https://qianfan.baidubce.com/v2/tokenplan/personal`,Bearer 鉴权,专用 Token Plan API Key);`deepseek-v4-pro`/`deepseek-v4-flash` 串与 DeepSeek 官方相同,现有写死模型串原样可用;只需扩 provider 枚举/DEFAULTS、复用/扩展火山同款的按 provider 选校验探针、onboarding 加一项、i18n 加两条文案。

## 1. 动机与调研结论

用户已持有千帆 Token Plan 个人版 API Key,希望像 `volcengine` 一样接入,**仅需 DeepSeek 的 v4 pro 与 flash 两档**;Token Plan 里其它模型(glm-5.2/5.1、kimi-k2.6、ernie-5.1)不支持。

调研来源:`https://console.bce.baidu.com/qianfan/resource/token-plan`(控制台落地页)+ `https://cloud.baidu.com/doc/qianfan/s/Dmrabu8b6`(Token Plan 个人版 API 文档,2026-07-14 抓取)。

- **协议**:文档给出两条兼容路径——
  - OpenAI 兼容:base `https://qianfan.baidubce.com/v2/tokenplan/personal`,完整端点 `.../chat/completions`。
  - Anthropic 兼容:base `https://qianfan.baidubce.com/anthropic/tokenplan/personal`,完整端点 `.../v1/messages`。
  DAO 的 client 固定走 `${baseUrl}/chat/completions` + `Authorization: Bearer`(OpenAI 兼容),故取 **OpenAI 兼容 base**,协议层零改动,与 `volcengine` 同款。
- **模型**:文档列出的 Token Plan 个人版模型含 `deepseek-v4-pro`、`deepseek-v4-flash`、`glm-5.2`、`glm-5.1`、`kimi-k2.6`、`ernie-5.1`。**DeepSeek 两档串与 DAO 现用的完全相同**——与 `volcengine` 子项目一样的幸运结论,不引入分档表。
- **Key 来源**:Token Plan 个人版**要求专用 API Key**,不能用千帆平台通用 Key;从控制台「我的订阅」页(`console.bce.baidu.com/qianfan/resource/token-plan`)获取。
- **套餐**:月度共享 token 池,Mini(10M/¥9.9)、Lite(42M/¥40)、Pro(230M/¥200)、Max(700M/¥600),按月计费刷新。
- **使用限制**(文档原文强调):仅限编程工具/Agent 平台内的交互式使用,不可用于自动化脚本或应用后端,违反可能导致订阅暂停或 Key 被封禁。这是外部约束,不在 DAO 代码里做强制(DAO 本身就是交互式编程工具,天然符合)。
- **`/models` 端点是否存在**:文档只列出 `chat/completions`(OpenAI 兼容)与 `v1/messages`(Anthropic 兼容)两个端点,**未提及 `/models`**。与 `volcengine` coding-plan 路径一样,判定为大概率不存在,采用同款最小 `chat/completions` 探针兜底(§2.3);留待真实 key 实测确认(§5)。

> 取消分档表的理由:与 `volcengine` 完全一致——DeepSeek 两档串两边一字不差,分档表是过度设计(YAGNI)。

## 2. 架构改动点

### 2.1 扩 provider 抽象(`src/config/profiles.ts`)

```ts
export type Provider = "deepseek" | "anthropic" | "openai" | "volcengine" | "qianfan";

export const DEFAULTS: Record<Provider, { baseUrl: string; model: string }> = {
  deepseek:   { baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro" },
  volcengine: { baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3", model: "deepseek-v4-pro" },
  qianfan:    { baseUrl: "https://qianfan.baidubce.com/v2/tokenplan/personal", model: "deepseek-v4-pro" },
  anthropic:  { baseUrl: "https://api.anthropic.com", model: "claude-opus-4-8" },
  openai:     { baseUrl: "https://api.openai.com/v1", model: "gpt-5" },
};
```

`deepseek-v4-flash` 在千帆下同样有效,现存写死 flash 串的位置无需改动(deepseek/volcengine/qianfan 共用同一组模型串)。

### 2.2 凭证来源

无需新增 env 源——DAO 已在 volcengine 上线后的一次改动里**去掉了环境变量 API key 支持**(`CHANGELOG.md:23`),统一走 profile(`~/.dao/config.json`/钥匙串,`/account`/`/login` 管理)或 headless 的 `--api-key <key> --provider <provider>`。千帆直接复用这条路径,只需把 `"qianfan"` 加进 `--provider` 的合法值列表(`src/index.ts:244`)。

### 2.3 校验探针(`src/config/validate_key.ts`)

现状:`cred.provider === "volcengine"` 时用最小 `chat/completions` 探针(POST,`model: "deepseek-v4-flash"`, `max_tokens: 1`),其余 provider 走 `${baseUrl}/models`(GET)。

千帆 Token Plan 路径大概率同样没有 `/models`(§1 已说明),复用同一条 chat 探针分支,把判定条件从单值改成集合:

```ts
if (cred.provider === "volcengine" || cred.provider === "qianfan") {
  // coding/token-plan 路径无 /models;用一发最小 chat 探针判鉴权(max_tokens:1)。
  ...
}
```

200→ok;401/403→invalid;其它→http;网络错→unreachable。与 volcengine 完全同款判定逻辑,零新增分支。

### 2.4 onboarding 加一项

`ProviderStep.tsx` 的 `Select` 加第三项 `{ label: t("onboard.provider.qianfan"), value: "qianfan" }`;`KeyStep.tsx` 的 help-key 三选一(从二元 ternary 改三元链或查表)。i18n(`zh.ts`/`en.ts`)加 `onboard.provider.qianfan`、`onboard.key.help.qianfan`(指向控制台「我的订阅」页)。

### 2.5 反思节奏(`src/index.ts` 的 `maybeReflect`)

现有判定是 `resolved.provider === "deepseek"` 走不限流,其余(含 volcengine、未来任何非 deepseek provider)一律走自适应 cadence——千帆同样是按月计费的付费额度,**天然落入现有的 else 分支,代码逻辑零改动**。仅把相关注释从「volcengine CodingPlan」泛化为「非 deepseek 官方 key(付费额度/计费敏感)」,避免注释误导为专指火山。

## 3. 不做什么(YAGNI)

- **不引入分档表/模型映射层**(DeepSeek 两档串两边一致)。
- 不支持 Token Plan 里的 glm/kimi/ernie 等非 DeepSeek 模型。
- 不接 Anthropic 兼容协议路径(DAO 是 OpenAI 兼容 client)。
- 不做套餐额度(Mini/Lite/Pro/Max)的用量追踪/展示——DAO 对 volcengine 的额度同样只是透传错误,不建模。
- 不在代码里强制"仅限交互式使用"的平台限制——DAO 本身即交互式编程工具,天然合规,无需运行时校验。

## 4. 单元测试(mock fetch,不依赖真实 key)

- `profiles.test.ts`:`DEFAULTS.qianfan` 存在且 baseUrl/model 正确;`Provider` union 含 qianfan。
- `validate_key.test.ts`:qianfan 走 chat 探针分支(200/401/网络错 → ok/invalid/unreachable);deepseek 仍走 `/models`(既有回归)。
- `steps_select.test.tsx`:`ProviderStep` 两次 DOWN 选中 qianfan。
- `i18n.test.ts`:`onboard.provider.qianfan`/`onboard.key.help.qianfan` 中英文案存在。
- 回归:既有 deepseek/volcengine 全链路全绿。

## 5. 验收 gate(实测,需真实千帆 Token Plan key,用户已持有)

1. headless 用 `--api-key <真实 key> --provider qianfan` 跑通一轮真实对话(`deepseek-v4-pro`,base `.../v2/tokenplan/personal`)。
2. 确认校验探针:先确认 `/models` 是否真的不存在(若存在且更省 token,可后续切回 GET /models,但当前先用 chat 探针兜底不阻塞)。
3. `deepseek-v4-flash` 单独验证可调。
4. usage/计费日志正确记账到 qianfan 调用,不串到 deepseek/volcengine 账。
5. `/account` 添加流程里选 `qianfan` 走通(粘 key → 校验 → 存钥匙串/文件)。

## 6. 风险与待实测确认项

| 项 | 风险 | 处置 |
|---|---|---|
| `/models` 探针 | 文档未列出该端点,可能确实不存在,也可能只是文档遗漏 | 先用 volcengine 同款 chat 探针兜底;实测若发现 `/models` 其实可用,不影响正确性(chat 探针更贵一点点但仍是最小 token) |
| 模型串 | 官方文档已列出 `deepseek-v4-pro`/`deepseek-v4-flash`,与 DAO 现用一致 | 低风险;`DEFAULTS` 仍可后续覆盖以防改名 |
| 套餐额度 | 月度共享 token 池,超限行为未知(报错/降级/断流) | 超限错误透传给用户,呈现来源;不在本子项目建模 |
| 使用限制 | 平台明文禁止脚本/后端自动化调用 | DAO 是交互式工具,天然合规;不写运行时校验 |

## 7. 与既有子项目的关系

千帆是 `volcengine`(子项目 C)之后的第二个 coding-plan 型 provider,复用同一套已验证的最小改动骨架(provider 枚举/DEFAULTS/探针选择/onboarding 加项),不新增抽象层。i18n 展示层(子项目 B)与道家 onboarding 整合层(子项目 A)已支持"任意 provider 的 meta",千帆直接消费,无需改动 A/B 的既有机制。
