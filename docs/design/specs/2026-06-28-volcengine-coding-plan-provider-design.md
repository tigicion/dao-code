# 火山引擎 coding plan provider — 设计定稿(子项目 C)

> 给 DAO 接火山方舟 Coding Plan:新增 `volcengine` provider,用一张【按 provider 的模型分档表】把散落的裸模型串收口,使 `deepseek-v4-pro`/`flash` 两档在不同 provider 下各自解析到正确 model id。client/协议零改动(OpenAI 兼容)。

定稿日期 2026-06-28。这是「初次登录重做 + 英文支持 + 火山引擎」三件套里的**子项目 C**,推进顺序 **C→B→A**(C 最小、可独立实测,先降风险;B=i18n 基础;A=道家 onboarding 整合层,依赖 B/C)。

---

## 0. 一句话

新增 `volcengine` provider(OpenAI 兼容,base `https://ark.cn-beijing.volces.com/api/coding/v3`,Bearer 鉴权);引入按 provider 的 `{ pro, flash }` 分档表,把代码里 ~6 处裸 `"deepseek-v4-flash"` 串收口成 `tierModel("flash")`;火山若无 flash 档则回退 pro;精确 model id 与校验探针在实测 gate 用真实 ARK key 敲死。

## 1. 动机与调研结论

用户要支持火山方舟 Coding Plan,**仅需 DeepSeek 的 v4 pro 与 flash 两档**,coding plan 里其它模型(Doubao/GLM/Kimi)不支持。

调研(2026-06 火山官方文档/活动页):
- **协议**:coding plan 提供 OpenAI 兼容 base `https://ark.cn-beijing.volces.com/api/coding/v3` 与 Anthropic 兼容 base `https://ark.cn-beijing.volces.com/api/coding`。DAO 的 client 是 `${baseUrl}/chat/completions` + `Authorization: Bearer`,**正好对上 OpenAI 兼容路径,协议层零改动**。
- **模型**:2026 年更新后 coding plan 已支持 **DeepSeek-V4 系列**(早期文档只有 V3.2),并提供 `ark-code-latest` 这个 latest 标识;通过配置 Model Name 实时切换。**精确的 v4-pro / v4-flash model id 字符串需用真实 key 实测敲死**(见 §6)。
- **Key 来源**:火山方舟控制台 → API Key 管理页。
- **套餐**:Lite(约 1200 次/5h、9000 次/周、18000 次/月)与 Pro(5× Lite 额度与 TPM),自然月计费,额度按 5h/周/月 周期刷新。

现状阻碍:DAO 把 `"deepseek-v4-flash"` 当**裸字符串**散在 ~6 处(分类器、skill 转换、摘要兜底、distill、子代理模型归一化),`pro` 来自 profile.model。直接换 provider 会让这些裸串在火山下指向不存在的模型。核心洞察:**模型分档(pro/flash)是逻辑概念,应按当前生效 provider 解析,而非硬编码 DeepSeek 的串。**

## 2. 架构改动点

### 2.1 扩 provider 抽象(`src/config/profiles.ts`)

```ts
export type Provider = "deepseek" | "anthropic" | "openai" | "volcengine";

export const DEFAULTS: Record<Provider, { baseUrl: string; model: string }> = {
  deepseek:   { baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro" },
  volcengine: { baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3", model: "<ark v4-pro id, 实测敲死>" },
  anthropic:  { baseUrl: "https://api.anthropic.com", model: "claude-opus-4-8" },
  openai:     { baseUrl: "https://api.openai.com/v1", model: "gpt-5" },
};
```

### 2.2 模型分档表(C 的核心,新增 `src/config/model_tiers.ts`)

逻辑档(`"pro" | "flash"`)→ 具体 model id,**按 provider 解析**:

```ts
export type Tier = "pro" | "flash";
const TIERS: Record<Provider, Record<Tier, string>> = {
  deepseek:   { pro: "deepseek-v4-pro", flash: "deepseek-v4-flash" },
  volcengine: { pro: "<ark v4-pro id>", flash: "<ark v4-flash id 或 = pro>" }, // 实测敲死;无 flash 档则 flash=pro
  anthropic:  { pro: "claude-opus-4-8", flash: "claude-opus-4-8" },            // 无分档,二者同
  openai:     { pro: "gpt-5", flash: "gpt-5" },
};
// 解析当前生效 provider 的某一档;env 覆盖(DAO_CLASSIFIER_MODEL/DAO_FALLBACK_MODEL/DAO_SUMMARY_MODEL)优先级不变。
export function tierModel(tier: Tier, provider: Provider): string { return TIERS[provider][tier]; }
```

**收口点**(把裸 `"deepseek-v4-flash"` 替换为 `tierModel("flash", activeProvider)`):
- `src/index.ts`:617/621/622(分类器)、697(skill 转换)、859(FALLBACK_MODEL)、1014(快速查询)
- `src/memory/distill.ts`(distill flash)
- `src/tools/agent.ts`:10–12(子代理模型名归一化——`flash`/`pro` 关键词 → 对应 provider 的全名,不再硬编码 deepseek 串)

> 现有 env 覆盖(`DAO_CLASSIFIER_MODEL` 等)语义不变:**显式 env > 分档表**。分档表只兜未设 env 的默认。

**火山无 flash 档的回退**:`TIERS.volcengine.flash` 直接填 pro 的 id。后果=廉价子任务/分类器/摘要兜底改用主模型,单价更高但**功能不丢**;实测确认火山是否真有独立 flash 再决定是否保留回退。

### 2.3 生效 provider 的传递

`tierModel` 需要知道当前 provider。当前 `cfg = { apiKey, baseUrl, model }` 不带 provider;`resolved.provider` 有。最小改动:把 `resolved.provider` 透传到这 ~6 处的调用上下文(已在 `index.ts` 作用域内可见 `resolved`),不改下游 `cfg` 形态(避免动 20+ 处)。

### 2.4 校验探针(`src/config/validate_key.ts`)

现状打 `${baseUrl}/models`。火山 coding plan 路径 `.../api/coding/v3/models` **可能不存在** → 实测确认。若不存在,为 volcengine 改用一发最小 `chat/completions` 探针(`max_tokens:1`)判鉴权:200=ok,401/403=invalid,其它=http。设计上把 validate 做成**可按 provider 选探针**(deepseek 仍用 `/models`,volcengine 视实测结果定)。

### 2.5 C 阶段如何选到火山(完整 onboarding 整合留给 A)

- **profile 加项路径**:复用现有 `/account` 加 profile 流程,允许 `provider=volcengine`(meta 取 `DEFAULTS.volcengine`)。
- **env 兜底**:新增 `ARK_API_KEY` + 可选 `ARK_BASE_URL`/`ARK_MODEL`,在 `resolveActive` 里作为一种 env 源(与现有 `DEEPSEEK_API_KEY` 并列,provider=volcengine)。来源仍显式呈现(杜绝静默计费惊吓)。

> 首启 wizard 里直接"选 provider"的连贯交互**不在 C**,属 A(道家 onboarding)。C 只保证火山能被配置、能跑通、能实测。

## 3. 不做什么(YAGNI)

- 不支持 coding plan 里 Doubao/GLM/Kimi 等非 DeepSeek 模型。
- 不接 Anthropic 兼容协议路径(DAO 是 OpenAI 兼容,用不上)。
- 不动 i18n / onboarding 交互(分别属 B / A)。
- 不引入 endpoint id(`ep-xxx`)模式——coding plan 用 model name 直连,无需自建接入点。

## 4. 单元测试(mock fetch,不依赖真实 key)

- `model_tiers.test.ts`:各 provider 的 pro/flash 解析正确;volcengine flash 回退 pro;env 覆盖优先于分档表。
- `profiles.test.ts`:`DEFAULTS.volcengine` 存在;`Provider` union 含 volcengine;迁移逻辑不回归。
- `validate_key.test.ts`:volcengine 探针路径分支(mock 200/401/网络错 → ok/invalid/unreachable)。
- `resolveActive`:`ARK_API_KEY` env 源解析为 volcengine + 正确 baseUrl,来源串正确。
- 回归:既有 deepseek 路径全绿(裸串收口不改变 deepseek 行为)。

## 5. 验收 gate(实测,需真实 ARK coding-plan key)

用户提供火山方舟 ARK coding-plan key 后:
1. 校验通过(确认 `/models` 是否可用,否则启用 chat 探针)。
2. 一轮真实对话跑通(OpenAI 兼容 `chat/completions` + Bearer)。
3. **敲死精确 model id**:确认 v4-pro 的真实串、以及火山是否有独立 flash 档(决定 `TIERS.volcengine.flash` 填独立 id 还是回退 pro);更新 `DEFAULTS.volcengine.model` 与 `model_tiers.ts`。
4. pro 与 flash(或回退)两条路径都验证可调。
5. usage/计费日志正确记账到火山调用。

> 用户已确认:有 key,稍后提供。故先落 code + 单测合入,实测 gate 在 key 到位后执行并据实回填 model id。

## 6. 风险与待实测确认项

| 项 | 风险 | 处置 |
|---|---|---|
| 精确 model id | 文档未给死 v4-pro/flash 的 id 串 | 实测敲死;`DEFAULTS`/`TIERS` 留 env 覆盖便于 pin |
| 是否有独立 flash 档 | 火山可能只暴露单 DeepSeek 模型 | flash 回退 pro(功能不丢),实测后定 |
| `/models` 探针 | coding plan 路径可能无此端点 | 按 provider 选探针,volcengine 用 chat 探针兜底 |
| 额度/限流 | coding plan 有 5h/周/月 额度上限 | 超限错误透传给用户,呈现来源与额度信息(后续可增强) |

## 7. 与 B/A 的接口

- **给 B(i18n)**:本子项目不产出用户可见新文案(env 指引复用现有 KEY_HELP 风格);若新增火山 KEY_HELP 文案,按 B 的 locale 机制做成可切。
- **给 A(onboarding)**:A 的首启「选 provider」直接消费 `DEFAULTS`/`Provider` union 与本子项目的 wizard 复用点;C 已保证 wizard 能接受任意 provider 的 meta。
