# 火山引擎 coding plan provider — 设计定稿(子项目 C)

> 给 DAO 接火山方舟 Coding Plan:新增 `volcengine` provider。**关键事实**:火山 coding plan 的 Model Name 列表里 DeepSeek 两档的精确串就是 `deepseek-v4-pro` / `deepseek-v4-flash`——与 DAO 现用串**完全一致**,唯一区别是 `baseUrl`。因此**无需任何模型映射/分档表**,client/协议零改动(OpenAI 兼容)。

定稿日期 2026-06-28。这是「初次登录重做 + 英文支持 + 火山引擎」三件套里的**子项目 C**,推进顺序 **C→B→A**(C 最小、可独立实测,先降风险;B=i18n 展示层;A=道家 onboarding 整合层,依赖 B/C)。

---

## 0. 一句话

新增 `volcengine` provider(OpenAI 兼容,base `https://ark.cn-beijing.volces.com/api/coding/v3`,Bearer 鉴权);火山的 `deepseek-v4-pro`/`deepseek-v4-flash` 串与 DeepSeek 官方相同,故现有写死的模型串原样可用、**不引入分档表**;只需扩 provider 枚举/DEFAULTS、按 provider 选校验探针、加 `ARK_API_KEY` env 源。

## 1. 动机与调研结论

用户要支持火山方舟 Coding Plan,**仅需 DeepSeek 的 v4 pro 与 flash 两档**,coding plan 里其它模型(Doubao/GLM/Kimi/MiniMax)不支持。

调研(2026-06,以火山官方文档「模型配置」页截图为准):
- **协议**:coding plan OpenAI 兼容 base `https://ark.cn-beijing.volces.com/api/coding/v3`。DAO 的 client 是 `${baseUrl}/chat/completions` + `Authorization: Bearer`,**正好对上,协议层零改动**。
- **模型(已用官方文档截图确认)**:coding plan「配置 Model Name」支持列表含 `deepseek-v4-pro` 与 `deepseek-v4-flash`(并支持全小写)。**这两个串与 DAO 现用的完全相同**(DAO 对 `api.deepseek.com` 也用这两个串)。另有 `ark-code-latest` 作为"控制台里切 latest"的别名,本子项目不用。
- **关键推论**:DeepSeek 与火山,DAO 用到的模型串**一字不差**。切 provider = **只换 baseUrl + key**。之前担心的"火山无 flash 档 / id 不同"已被截图证伪。
- **Key 来源**:火山方舟控制台 → API Key 管理页。
- **套餐**:Lite(约 1200 次/5h、9000 次/周、18000 次/月)与 Pro(5× Lite 额度与 TPM),自然月计费,额度按 5h/周/月 周期刷新。

> 取消分档表的理由(回应"分档表是要做什么"):分档表本是为"火山的 flash 串与 DeepSeek 不同、甚至没有 flash 档"做的解耦保险。截图证明两边串一致,该不匹配不存在 → 表属过度设计(YAGNI),删。代码里 ~6 处写死的 `"deepseek-v4-flash"`(分类器/skill 转换/摘要兜底/distill/快速查询/子代理归一化)在火山下**原样有效,一行不动**。

## 2. 架构改动点

### 2.1 扩 provider 抽象(`src/config/profiles.ts`)

```ts
export type Provider = "deepseek" | "anthropic" | "openai" | "volcengine";

export const DEFAULTS: Record<Provider, { baseUrl: string; model: string }> = {
  deepseek:   { baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro" },
  volcengine: { baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3", model: "deepseek-v4-pro" },
  anthropic:  { baseUrl: "https://api.anthropic.com", model: "claude-opus-4-8" },
  openai:     { baseUrl: "https://api.openai.com/v1", model: "gpt-5" },
};
```

`deepseek-v4-flash` 在火山下同样有效,故所有现存写死 flash 串的位置**无需改动**(deepseek 与 volcengine 共用同一组串)。

### 2.2 env 兜底(`src/config/profiles.ts` 的 `resolveActive`)

新增 `ARK_API_KEY`(+ 可选 `ARK_BASE_URL` / `ARK_MODEL`)作为一种 env 源,与现有 `DEEPSEEK_API_KEY` 并列,解析为 `provider: "volcengine"`、baseUrl 默认 `DEFAULTS.volcengine.baseUrl`、model 默认 `DEFAULTS.volcengine.model`。来源串 `env:ARK_API_KEY` 仍显式呈现(杜绝静默计费惊吓)。

> 完整首启"选 provider"的连贯交互属 A(道家 onboarding),不在 C。C 只保证火山能被配置、能跑通。

### 2.3 校验探针(`src/config/validate_key.ts`)

现状打 `${baseUrl}/models`。火山 coding plan 路径 `.../api/coding/v3/models` **可能不存在** → 实测确认(§5)。若不存在,把 validate 做成**可按 provider 选探针**:volcengine 改用一发最小 `chat/completions`(`model: "deepseek-v4-flash"`, `max_tokens: 1`)判鉴权——200=ok,401/403=invalid,其它=http,网络错=unreachable。deepseek 维持 `/models` 不变。

### 2.4 profile 加项路径

复用现有 `/account` 加 profile 流程,允许 `provider=volcengine`(meta 取 `DEFAULTS.volcengine`),走同一套 `runKeyWizard`(粘 key → 校验 → 钥匙串/文件存储)。

## 3. 不做什么(YAGNI)

- **不引入分档表 / 模型映射层**(截图证明两边串一致)。
- 不支持 coding plan 里 Doubao/GLM/Kimi/MiniMax 等非 DeepSeek 模型。
- 不接 Anthropic 兼容协议路径(DAO 是 OpenAI 兼容)。
- 不用 `ark-code-latest` 别名(直连具体 `deepseek-v4-*` 串更可控)。
- 不引入 endpoint id(`ep-xxx`)模式——coding plan 用 model name 直连。
- 不动 i18n / onboarding 交互(分别属 B / A)。

## 4. 单元测试(mock fetch,不依赖真实 key)

- `profiles.test.ts`:`DEFAULTS.volcengine` 存在且 baseUrl/model 正确;`Provider` union 含 volcengine;旧版迁移不回归。
- `resolveActive`:`ARK_API_KEY` env 源解析为 volcengine + 正确 baseUrl/model,来源串 `env:ARK_API_KEY`;与 `DEEPSEEK_API_KEY` 共存时的优先级明确。
- `validate_key.test.ts`:volcengine 探针分支(mock chat 探针 200/401/网络错 → ok/invalid/unreachable);deepseek 仍走 `/models`。
- 回归:既有 deepseek 全链路全绿(本子项目不动任何写死模型串)。

## 5. 验收 gate(实测,需真实 ARK coding-plan key)

用户已确认有 key,稍后提供。拿到后:
1. 用 `deepseek-v4-pro` 跑通一轮真实对话(OpenAI 兼容 `chat/completions` + Bearer,base `.../api/coding/v3`)。
2. 确认校验探针:先试 `/models`,若 4xx/404 则确认 chat 探针路径生效。
3. `deepseek-v4-flash` 单独验证可调(子代理/分类器路径)。
4. usage/计费日志正确记账到火山调用。

> 先合 code + 单测;实测 gate 在 key 到位后执行。模型串已由官方文档截图确认,实测主要验"链路通 + 探针对 + 计费记账",而非敲 id。

## 6. 风险与待实测确认项

| 项 | 风险 | 处置 |
|---|---|---|
| `/models` 探针 | coding plan 路径可能无此端点 | 按 provider 选探针,volcengine 用最小 chat 探针兜底(§2.3) |
| 模型串 | 已由官方文档截图确认 `deepseek-v4-pro/flash` | 低风险;`DEFAULTS`/env 仍可覆盖以防官方改名 |
| 额度/限流 | coding plan 有 5h/周/月 额度上限 | 超限错误透传,呈现来源(后续可增强额度展示) |

## 7. 与 B/A 的接口

- **给 B(i18n)**:本子项目不产出用户可见新文案(env 指引复用现有 KEY_HELP 风格);若新增火山 KEY_HELP,按 B 的 locale 机制做成可切。
- **给 A(onboarding)**:A 的首启「选 provider」直接消费 `DEFAULTS`/`Provider` union;C 已保证 `runKeyWizard` 能接受任意 provider 的 meta。
