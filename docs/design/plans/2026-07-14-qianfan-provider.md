# 千帆 Token Plan provider 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 DAO 接百度千帆 Token Plan(个人版)——新增 `qianfan` provider,使一个千帆 Token Plan key 能跑 DeepSeek v4 pro/flash。

**Architecture:** 千帆 Token Plan 的 `deepseek-v4-pro`/`deepseek-v4-flash` 串与 DAO 现用串完全一致,OpenAI 兼容协议(base `https://qianfan.baidubce.com/v2/tokenplan/personal`),故 client/模型串零改动。改动复用 `volcengine` 已验证的骨架:`profiles.ts`(provider 枚举 + DEFAULTS)、`validate_key.ts`(把 chat 探针分支从单值判定扩成 volcengine/qianfan 集合判定)、`index.ts`(`--provider` 合法值列表加一项)、onboarding(`ProviderStep`/`KeyStep`)、i18n(`zh.ts`/`en.ts`)。

**Tech Stack:** TypeScript (ESM, `.js` import 后缀)、vitest(`npm test` = `vitest run`)、注入式 fetch 假实现做单测、ink-testing-library 测 onboarding 组件。

**Spec:** `docs/design/specs/2026-07-14-qianfan-coding-plan-provider-design.md`

## Global Constraints

- 模型串:千帆与 DeepSeek/火山共用 `deepseek-v4-pro` / `deepseek-v4-flash`,**不引入分档表/映射层**,代码里既有写死模型串一行不动。
- 千帆 base url:`https://qianfan.baidubce.com/v2/tokenplan/personal`(OpenAI 兼容);鉴权 `Authorization: Bearer <key>`(专用 Token Plan key,非千帆通用 key)。
- ESM import 一律带 `.js` 后缀;测试文件 `*.test.ts`/`*.test.tsx` 与被测同目录。
- 不新增环境变量凭证源——env-var API key 支持已在此前一次改动里整体移除(`CHANGELOG.md:23`),千帆走 profile/`/account`/headless `--api-key --provider` 同一条路径。
- 交互式 onboarding「选 provider」需要把 `qianfan` 加进 `Select` 列表(与 volcengine 并列的正式一项,非仅 headless/env 路径)。
- commit message 不加任何 AI 署名。

---

### Task 1: provider 枚举 + DEFAULTS 加 qianfan

**Files:**
- Modify: `src/config/profiles.ts:5`(`Provider` union)、`src/config/profiles.ts:22-27`(`DEFAULTS`)
- Test: `src/config/profiles.test.ts`

**Interfaces:**
- Produces: `Provider` 含 `"qianfan"`;`DEFAULTS.qianfan = { baseUrl: "https://qianfan.baidubce.com/v2/tokenplan/personal", model: "deepseek-v4-pro" }`

- [ ] **Step 1: 写失败测试**

在 `src/config/profiles.test.ts` 末尾追加:

```ts
describe("DEFAULTS.qianfan", () => {
  it("points at the token-plan base url with deepseek-v4-pro as default model", () => {
    expect(DEFAULTS.qianfan).toEqual({
      baseUrl: "https://qianfan.baidubce.com/v2/tokenplan/personal",
      model: "deepseek-v4-pro",
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/config/profiles.test.ts`
Expected: FAIL —`DEFAULTS.qianfan` 为 undefined(`toEqual` 不匹配),或 TS 报 `qianfan` 不在 `Provider` 上。

- [ ] **Step 3: 最小实现**

`src/config/profiles.ts:5` 改 union:

```ts
export type Provider = "deepseek" | "anthropic" | "openai" | "volcengine" | "qianfan";
```

`src/config/profiles.ts` 的 `DEFAULTS` 加一项(`Record<Provider,…>` 会强制补全):

```ts
export const DEFAULTS: Record<Provider, { baseUrl: string; model: string }> = {
  deepseek: { baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro" },
  volcengine: { baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3", model: "deepseek-v4-pro" },
  qianfan: { baseUrl: "https://qianfan.baidubce.com/v2/tokenplan/personal", model: "deepseek-v4-pro" },
  anthropic: { baseUrl: "https://api.anthropic.com", model: "claude-opus-4-8" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-5" },
};
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `npm test -- src/config/profiles.test.ts`
Expected: PASS
Run: `npm run typecheck`
Expected: 无新增类型错误(确认加 union 没破坏别处穷尽性——尤其 `src/index.ts` 里 `cliProvider` 的判定和 onboarding 的 provider 分支)。

- [ ] **Step 5: 提交**

```bash
git add src/config/profiles.ts src/config/profiles.test.ts
git commit -m "feat(provider): 新增 qianfan provider 与 token-plan DEFAULTS"
```

---

### Task 2: 校验探针扩展到 qianfan

**Files:**
- Modify: `src/config/validate_key.ts:17`(条件从单值改集合)
- Test: `src/config/validate_key.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Provider`(含 `"qianfan"`)
- Produces: `validateCredential` 对 `provider === "volcengine" || provider === "qianfan"` 都走最小 `chat/completions` 探针(POST,`model: "deepseek-v4-flash"`, `max_tokens: 1`);其余 provider(含未传 provider)维持 `${baseUrl}/models`(GET)。

- [ ] **Step 1: 写失败测试**

在 `src/config/validate_key.test.ts` 末尾追加:

```ts
describe("validateCredential · qianfan probe", () => {
  const qf = { baseUrl: "https://qianfan.baidubce.com/v2/tokenplan/personal", key: "qf-x", provider: "qianfan" as const };

  it("probes chat/completions with a tiny POST for qianfan", async () => {
    let seenUrl = ""; let seenMethod = "";
    const fakeFetch = async (url: string, init?: { method?: string }) => {
      seenUrl = url; seenMethod = init?.method ?? "GET";
      return { ok: true, status: 200 } as Response;
    };
    const r = await validateCredential(qf, fakeFetch as unknown as typeof fetch);
    expect(r.ok).toBe(true);
    expect(seenUrl).toBe("https://qianfan.baidubce.com/v2/tokenplan/personal/chat/completions");
    expect(seenMethod).toBe("POST");
  });

  it("reports invalid on 401 for qianfan", async () => {
    const fakeFetch = async () => ({ ok: false, status: 401 } as Response);
    expect(await validateCredential(qf, fakeFetch as unknown as typeof fetch)).toEqual({ ok: false, reason: "invalid" });
  });

  it("reports unreachable when the qianfan probe throws", async () => {
    const fakeFetch = async () => { throw new Error("ENOTFOUND"); };
    expect(await validateCredential(qf, fakeFetch as unknown as typeof fetch)).toEqual({ ok: false, reason: "unreachable" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/config/validate_key.test.ts`
Expected: FAIL — qianfan 仍打 `/models`(GET),`seenUrl`/`seenMethod` 不匹配。

- [ ] **Step 3: 最小实现**

`src/config/validate_key.ts:17` 把单值判定改成集合判定(其余 body 不变):

```ts
    if (cred.provider === "volcengine" || cred.provider === "qianfan") {
      // coding/token-plan 路径无 /models;用一发最小 chat 探针判鉴权(max_tokens:1)。
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `npm test -- src/config/validate_key.test.ts`
Expected: PASS(含既有 deepseek 4 用例 + volcengine 4 用例 + 新增 qianfan 3 用例)
Run: `npm run typecheck`
Expected: 无类型错误。

- [ ] **Step 5: 提交**

```bash
git add src/config/validate_key.ts src/config/validate_key.test.ts
git commit -m "feat(provider): 校验探针把 qianfan 并入 volcengine 同款 chat 探针分支"
```

---

### Task 3: headless `--provider qianfan` 支持

**Files:**
- Modify: `src/index.ts:244`
- Test: 手动验证(该行是 argv 解析,无既有单测覆盖;不新增测试基建,遵循既有做法)

**Interfaces:**
- Consumes: Task 1 的 `Provider`
- Produces: `cliProvider` 允许 `"qianfan"`,`headless --api-key <key> --provider qianfan` 可解析出合法凭证。

- [ ] **Step 1: 最小实现**

`src/index.ts:244` 改:

```ts
  const cliProvider = (cliProviderRaw === "deepseek" || cliProviderRaw === "volcengine" || cliProviderRaw === "qianfan" || cliProviderRaw === "anthropic" || cliProviderRaw === "openai") ? cliProviderRaw : undefined;
```

顺手把 `src/index.ts:239` 的注释同步一下(原文列了 `<deepseek|volcengine|...>`,加个例子即可,不强制):

```ts
  // headless 临时 key:--api-key <key> + --provider <deepseek|volcengine|qianfan|...>
```

- [ ] **Step 2: 手动验证**

Run: `npm run build && node dist/index.js -p "hi" --api-key test-key --provider qianfan --dry-run` (若无 `--dry-run` 选项则改为观察 `resolved.provider` 是否为 `"qianfan"` 而非直接联网——可在 `src/index.ts` 临时加一行 `console.error(resolved)` 调试后移除,或跳过网络验证,只confirm argv 阶段 `cliProvider === "qianfan"` 未被过滤掉导致 fallback 到 undefined)
Expected: `--provider qianfan` 被识别为合法 provider,不落回 `undefined`(不会走 profile/onboarding 兜底路径)。

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck`
Expected: 无类型错误。

- [ ] **Step 4: 提交**

```bash
git add src/index.ts
git commit -m "feat(provider): headless --provider 支持 qianfan"
```

---

### Task 4: onboarding 加 qianfan 选项

**Files:**
- Modify: `src/tui/onboarding/steps/ProviderStep.tsx:16-18`
- Modify: `src/tui/onboarding/steps/KeyStep.tsx:24`
- Test: `src/tui/onboarding/steps/steps_select.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `Provider`;i18n key `onboard.provider.qianfan`/`onboard.key.help.qianfan`(Task 5 提供实际文案,此任务先引用 key)
- Produces: `ProviderStep` 的 `Select` 含三项(deepseek/volcengine/qianfan);`KeyStep` 按 provider 三选一取 help-key。

- [ ] **Step 1: 写失败测试**

在 `src/tui/onboarding/steps/steps_select.test.tsx` 的 `describe("ProviderStep", …)` 内追加:

```ts
  it("picks qianfan after two DOWN", async () => {
    const onPick = vi.fn();
    const { stdin } = render(<ProviderStep bg="dark" onPick={onPick} />);
    stdin.write(DOWN); await delay(); stdin.write(DOWN); await delay(); stdin.write(ENTER); await delay();
    expect(onPick).toHaveBeenCalledWith("qianfan");
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/tui/onboarding/steps/steps_select.test.tsx`
Expected: FAIL — `Select` 只有两项,第二次 DOWN 后仍停在 volcengine 或循环回 deepseek,`onPick` 收到的不是 `"qianfan"`。

- [ ] **Step 3: 最小实现**

`src/tui/onboarding/steps/ProviderStep.tsx`,`Select` 的 `items` 加第三项:

```tsx
        items={[
          { label: t("onboard.provider.deepseek"), value: "deepseek" },
          { label: t("onboard.provider.volcengine"), value: "volcengine" },
          { label: t("onboard.provider.qianfan"), value: "qianfan" },
        ]}
```

`src/tui/onboarding/steps/KeyStep.tsx:24` 把二元 ternary 改三元链:

```ts
  const helpKey = provider === "volcengine" ? "onboard.key.help.volcengine"
    : provider === "qianfan" ? "onboard.key.help.qianfan"
    : "onboard.key.help.deepseek";
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/tui/onboarding/steps/steps_select.test.tsx`
Expected: PASS(含既有 `LanguageStep`/`ProviderStep` volcengine 用例 + 新增 qianfan 用例)

> 注:此步骤 i18n key 尚未加文案(Task 5),`t()` 找不到 key 时按 `src/i18n/i18n.ts` 现有行为回退显示 key 本身,不影响本任务测试断言(断言的是 `onPick` 调用参数,不是显示文案)。

- [ ] **Step 5: 提交**

```bash
git add src/tui/onboarding/steps/ProviderStep.tsx src/tui/onboarding/steps/KeyStep.tsx src/tui/onboarding/steps/steps_select.test.tsx
git commit -m "feat(onboarding): provider 选择加入 qianfan"
```

---

### Task 5: i18n 文案

**Files:**
- Modify: `src/i18n/messages/zh.ts:9,12`(附近插入)
- Modify: `src/i18n/messages/en.ts:9,12`(附近插入)
- Test: `src/i18n/i18n.test.ts`

**Interfaces:**
- Consumes: Task 4 引用的 key 名
- Produces: `onboard.provider.qianfan`、`onboard.key.help.qianfan` 中英文案均可查到。

- [ ] **Step 1: 写失败测试**

在 `src/i18n/i18n.test.ts` 的 `it("has the onboarding step keys in both langs", …)` 测试体内追加两行:

```ts
    setLang("zh"); expect(t("onboard.provider.qianfan")).toBe("千帆 Token Plan");
    setLang("en"); expect(t("onboard.provider.qianfan")).toBe("Qianfan (Token Plan)");
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/i18n/i18n.test.ts`
Expected: FAIL — `t("onboard.provider.qianfan")` 回退返回 key 本身(`"onboard.provider.qianfan"`),与期望文案不符。

- [ ] **Step 3: 最小实现**

`src/i18n/messages/zh.ts`,在 `"onboard.provider.volcengine"` 行后插入:

```ts
  "onboard.provider.qianfan": "千帆 Token Plan",
```

在 `"onboard.key.help.volcengine"` 行后插入:

```ts
  "onboard.key.help.qianfan": "获取 key:千帆控制台 → 资源 → Token Plan → 我的订阅",
```

`src/i18n/messages/en.ts`,对应位置插入:

```ts
  "onboard.provider.qianfan": "Qianfan (Token Plan)",
```

```ts
  "onboard.key.help.qianfan": "Get a key: Qianfan console → Resources → Token Plan → My Subscriptions",
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/i18n/i18n.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/i18n/messages/zh.ts src/i18n/messages/en.ts src/i18n/i18n.test.ts
git commit -m "feat(i18n): 加 qianfan provider 的 onboarding 文案(zh/en)"
```

---

### Task 6: 反思节奏注释泛化(无行为改动)

**Files:**
- Modify: `src/index.ts:1204-1213`(仅注释)

**Interfaces:**
- Consumes: 无新接口
- Produces: 注释准确反映"非 deepseek 官方 key 一律自适应 cadence",不再专指 volcengine,避免千帆加入后注释误导。

- [ ] **Step 1: 改注释**

`src/index.ts:1204-1205` 与 `:1213` 的注释,把专指 volcengine 的措辞改成泛指:

```ts
  // 回合末入口:deepseek 官方 key 不限流,每轮都跑(仅 reflectBusy 防并发);
  // 其它 provider(volcengine/qianfan 等 coding-plan/token-plan,计费敏感)用自适应节奏(连续安静则放慢)。
```

```ts
    // 非 deepseek 官方 key(coding-plan/token-plan 计费敏感):自适应 cadence,省钱
```

代码逻辑(`resolved.provider === "deepseek"` 判定)本身已是"非 deepseek 即走自适应"的通用形式,**无需改动**——qianfan 自动落入该分支。

- [ ] **Step 2: 跑现有测试确认无回归**

Run: `npm test`
Expected: 全绿,注释改动不影响任何断言。

- [ ] **Step 3: 提交**

```bash
git add src/index.ts
git commit -m "docs(provider): 反思节奏注释从专指 volcengine 泛化为非 deepseek provider"
```

---

### Task 7: 全量回归 + 构建

**Files:** 无新增;验证整库未回归。

- [ ] **Step 1: 跑全量单测**

Run: `npm test`
Expected: 全绿(既有 deepseek/volcengine 全链路 + 新增 qianfan 用例)。

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: 无类型错误。

- [ ] **Step 3: 构建二进制(若发布链路需要)**

Run: `npm run build`
Expected: 构建成功,无类型错误。

- [ ] **Step 4:(无改动则跳过提交)**

若 build 产物纳入版本管理则按既有约定提交;否则本任务无 commit。

---

### Task 8: 实测 gate(需真实千帆 Token Plan key — 用户已持有)

> 非自动化任务。用户已确认有 key。code+单测先合(Task 1–7),本任务用真实 key 跑。

- [ ] **Step 1: headless 启动千帆**

```bash
node dist/index.js --api-key <真实千帆 Token Plan key> --provider qianfan -p "你好,简单自我介绍一下"
```
Expected: 正常收到回复,不报 401/404,`resolved.source` 为 `cli:--api-key`。

- [ ] **Step 2: 校验探针验证(首启 onboarding 路径)**

> 修正(全分支审查发现):`/account` 加账户流程目前硬编码 `provider: "deepseek"`(`src/index.ts:441-446`,新账户无 provider 选择器)——这是与 volcengine 共享的既有限制,本子项目未改动、也不在范围内。故校验探针改走首启 onboarding(`ProviderStep` 已在 Task 4 加了 qianfan 选项):清空/新建 `~/.dao/config.json` 测试目录后跑 `dao`,首启引导选语言 → 选 `qianfan` → 粘贴真实 key,观察校验是否通过。

Expected: 校验通过(✓ 已校验),若 `/chat/completions` 探针返回非 2xx,记录 status 并回到 Task 2 调整探针 body/model。

- [ ] **Step 3: pro 跑一轮真实对话**

发一条普通消息,确认走 `https://qianfan.baidubce.com/v2/tokenplan/personal/chat/completions`、`deepseek-v4-pro` 正常返回。
Expected: 正常回复,无 404/401。

- [ ] **Step 4: flash 路径验证**

临时 `DEFAULTS.qianfan.model` 或走子代理/分类器路径,确认 `deepseek-v4-flash` 在千帆下可调。
Expected: flash 调用成功。

- [ ] **Step 5: 计费/usage 记账**

确认 usage 日志正确记录千帆调用(token/费用 sink 不串到 deepseek/volcengine 账)。
Expected: 记账正确。

- [ ] **Step 6: onboarding 全流程验证**

新环境(或清空 `~/.dao/config.json` 的测试目录)跑首次启动引导,选语言 → 选 `qianfan` → 粘贴 key → 校验 → 完成。
Expected: 三选一列表正确显示"千帆 Token Plan",全流程无报错。

- [ ] **Step 7: 回填(如有偏差)**

若实测发现探针 body、base url 或模型串需微调,改对应代码 + 单测,提交:
```bash
git commit -m "fix(provider): 据千帆实测回填校验探针/base url/模型串"
```

---

## 追加:账户/模型管理加固 + GLM-5.2(2026-07-14 同日,真实 key 实测后回填)

> 背景见 `docs/design/specs/2026-07-14-qianfan-coding-plan-provider-design.md` §8。用真实千帆 key 验证 Task 1-8 全部通过后,全分支审查额外发现 4 处既有账户/模型管理缺口(deepseek/volcengine 同样受影响,非本 provider 引入),借用户提出的 glm-5.2 支持需求一并加固。以下 Task 9-12 延续 Task 1-8 的 TDD/单任务提交节奏,在同一分支完成。

**追加 Global Constraints:**
- 千帆 Token Plan 除 DeepSeek 两档外,**新增仅支持 `glm-5.2`**(用户明确要求)——kimi-k2.6/ernie-5.1 仍不支持,原 §3 YAGNI 条款收窄而非推翻。
- `cfg`(`src/index.ts` 顶层可变对象)已有 `provider` 字段(`cfg = { apiKey, baseUrl, model, provider }`),Task 9 只需在 `switchAccount`/`addAccount` 里补写这个已存在字段,不新增类型。
- `session.model`(`src/session/session.ts`)才是实际发请求用的字段;`cfg.model` 仅用于展示(`/config`)。任何"切账户/加账户"路径改了 provider/model 后必须调用 `session.setModel(...)` 同步。
- `src/index.ts` 的 `main()` 内闭包(`switchAccount`/`addAccount`/反思节奏判定)没有既有单测入口——同 Task 3 先例,允许用人工/受控验证代替单测,不新造测试基建去抽离这些闭包。
- commit message 不加任何 AI 署名。

---

### Task 9: 账户切换/新增全字段同步 + 反思节奏读活值而非启动快照

**Files:**
- Modify: `src/index.ts`(`switchAccount` ~420-428、`addAccount` ~441-454、反思节奏判定原 `resolved.provider === "deepseek"` 一行,现文件行号搜 `resolved.provider === "deepseek"` 定位)

**Interfaces:**
- Consumes:既有 `cfg`(含 `provider` 字段)、`session.setModel(model: string): void`
- Produces:`switchAccount`/`addAccount` 成功后,`cfg.apiKey`/`cfg.baseUrl`/`cfg.model`/`cfg.provider` 与 `session.model` 全部与新 profile 一致;反思节奏判定从 `cfg.provider`(活值)读,不再读 `resolved.provider`(启动时快照,switchAccount 之后永远不变)。

- [ ] **Step 1: 追加人工验证脚本(非自动化单测,先记录预期行为)**

由于这三处逻辑都在 `main()` 内闭包中且当前无从外部单测(同 Task 3),本任务不新增测试文件。改为在实现后由实现者手工验证(Step 4),并把观察记录写入报告——这是刻意的偏离 TDD 顺序,不是遗漏。

- [ ] **Step 2: 定位并改 `switchAccount`**

当前代码(`src/index.ts` 约 420-428 行):
```ts
  const switchAccount = (name: string): boolean => {
    if (!profilesCfg.profiles[name]) return false;
    profilesCfg = setActive(profilesCfg, name);
    saveProfiles(keyFile, profilesCfg).catch(() => {});
    resolveCredential(profilesCfg, kc).then((r) => {
      if (r) { cfg.apiKey = r.key; cfg.baseUrl = r.baseUrl; cfg.model = r.model; keySource = r.source; }
    }).catch(() => {});
    return true;
  };
```
改成:
```ts
  const switchAccount = (name: string): boolean => {
    if (!profilesCfg.profiles[name]) return false;
    profilesCfg = setActive(profilesCfg, name);
    saveProfiles(keyFile, profilesCfg).catch(() => {});
    resolveCredential(profilesCfg, kc).then((r) => {
      if (r) {
        cfg.apiKey = r.key; cfg.baseUrl = r.baseUrl; cfg.model = r.model; cfg.provider = r.provider; keySource = r.source;
        session.setModel(r.model); // 实际发请求用的字段;不重放会拿旧 provider 的模型串打新 baseUrl
      }
    }).catch(() => {});
    return true;
  };
```

- [ ] **Step 3: 定位并改 `addAccount` 的成功收尾**

当前代码(`src/index.ts` 约 441-454 行)结尾两行:
```ts
    cfg.apiKey = key; keySource = `profile:${targetName}`;
    return { ok: true, name: targetName };
```
改成:
```ts
    cfg.apiKey = key; cfg.baseUrl = meta.baseUrl; cfg.model = meta.model; cfg.provider = meta.provider; keySource = `profile:${targetName}`;
    session.setModel(meta.model);
    return { ok: true, name: targetName };
```
(`meta` 在同函数内已存在,类型为 `{ provider, baseUrl, model }`,直接复用即可,不用另取。)

- [ ] **Step 4: 改反思节奏判定读活值**

搜 `if (resolved.provider === "deepseek")`(`maybeReflect` 内),连同其上一行注释一起改:
```ts
  // 回合末入口:deepseek 官方 key 不限流,每轮都跑(仅 reflectBusy 防并发);
  // 其它 provider(volcengine/qianfan 等 coding-plan/token-plan,计费敏感)用自适应节奏(连续安静则放慢)。
  const maybeReflect = async (opts: { compactionImminent: boolean }): Promise<void> => {
    if (argvPrompt || NO_MEMORY) return;
    // 非 deepseek 官方 key(coding-plan/token-plan 计费敏感):自适应 cadence,省钱。
    // 读 cfg.provider(活值,随 /account 切换更新)而非 resolved.provider(启动时快照,切账户后不再变)。
    if (cfg.provider === "deepseek") {
```
(只改判定条件从 `resolved.provider` 到 `cfg.provider`,函数体其余逻辑不动。)

- [ ] **Step 5: 类型检查 + 全量回归**

Run: `npm run typecheck`
Expected: 无类型错误(`cfg.provider`/`meta.provider` 均已是 `Provider` 类型,赋值兼容)。
Run: `npm test`
Expected: 全量通过(此改动不触碰任何被测导出函数,只改 `main()` 内闭包实现)。

- [ ] **Step 6: 人工验证(用真实千帆 key,已由用户提供)**

构建后跑交互式 `dao`(需在受信目录),依次:
1. 用 `/account` 加一个 deepseek 账户(或用现有默认账户)。
2. 手工在 `~/.dao/config.json` 或走 Task 11(下一任务)加一个 qianfan 账户(Task 11 完成前,可用 `addAccount` 的 headless 默认 deepseek 路径先加测试账户,provider 手工改 config.json 亦可)。
3. `/account` 切到 qianfan 账户,`/config` 查看 `baseUrl`/`model` 是否变为千帆的值;发一条消息确认真实走千帆端点(非 404/401)。
4. 若切换后表现仍去打旧 baseUrl,回到 Step 2/3 检查。

Expected: 切换后下一回合请求即走新 provider 的 baseUrl/model,`/config` 展示与实际一致。

- [ ] **Step 7: 提交**

```bash
git add src/index.ts
git commit -m "fix(account): 切换/新增账户后同步 cfg.provider 与 session.model,反思节奏读活值"
```

---

### Task 10: MODELS_BY_PROVIDER 注册表 + `/model` provider-aware(含 glm-5.2)

**Files:**
- Modify: `src/config/profiles.ts`(`DEFAULTS` 之后新增 `MODELS_BY_PROVIDER`)
- Modify: `src/commands/commands.ts`(`dispatchCommand` 签名 + `"model"` 分支)
- Modify: `src/repl.ts`(`ReplDeps` 加 `getProvider` + 调用点传参)
- Modify: `src/index.ts`(两处 `dispatchCommand`/`runRepl` 调用点接入 provider)
- Test: `src/config/profiles.test.ts`、`src/commands/commands.test.ts`

**Interfaces:**
- Produces:`MODELS_BY_PROVIDER: Record<Provider, string[]>`;`dispatchCommand(input: string, session: Session, provider: Provider = "deepseek"): CommandResult`——`/model <arg>` 校验 `arg` 是否在 `MODELS_BY_PROVIDER[provider]` 里,不在则返回帮助性错误(列出可选值),不改 `session.model`;`/model`(无参)在该 provider 的已知模型列表里循环到下一个(而非硬编码两值 toggle)。

- [ ] **Step 1: 写失败测试(profiles.test.ts)**

在 `src/config/profiles.test.ts` 末尾追加:
```ts
describe("MODELS_BY_PROVIDER", () => {
  it("qianfan 额外支持 glm-5.2(与 pro/flash 并列)", () => {
    expect(MODELS_BY_PROVIDER.qianfan).toEqual(["deepseek-v4-pro", "deepseek-v4-flash", "glm-5.2"]);
  });
  it("deepseek 与 volcengine 只有共享的 pro/flash 两档", () => {
    expect(MODELS_BY_PROVIDER.deepseek).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"]);
    expect(MODELS_BY_PROVIDER.volcengine).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"]);
  });
});
```
别忘了在文件顶部 import 里加 `MODELS_BY_PROVIDER`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/config/profiles.test.ts`
Expected: FAIL — `MODELS_BY_PROVIDER` 未导出。

- [ ] **Step 3: 实现 `MODELS_BY_PROVIDER`**

`src/config/profiles.ts`,紧接 `DEFAULTS` 之后追加:
```ts
// 每个 provider 已知可用的模型串(/model 命令用来做校验+循环);deepseek/volcengine 只有 pro/flash 两档,
// qianfan 额外支持 glm-5.2(用户明确要求;kimi/ernie 等仍不支持,见 spec §8)。
export const MODELS_BY_PROVIDER: Record<Provider, string[]> = {
  deepseek: ["deepseek-v4-pro", "deepseek-v4-flash"],
  volcengine: ["deepseek-v4-pro", "deepseek-v4-flash"],
  qianfan: ["deepseek-v4-pro", "deepseek-v4-flash", "glm-5.2"],
  anthropic: [DEFAULTS.anthropic.model],
  openai: [DEFAULTS.openai.model],
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/config/profiles.test.ts`
Expected: PASS

- [ ] **Step 5: 写失败测试(commands.test.ts)**

在 `src/commands/commands.test.ts` 追加(顶部 import 若无 `Session` 之外的类型可不改):
```ts
it("/model 无参在 qianfan 下按 pro→flash→glm→pro 循环", () => {
  const s = sess(); // 初始 deepseek-v4-pro
  dispatchCommand("/model", s, "qianfan");
  expect(s.model).toBe("deepseek-v4-flash");
  dispatchCommand("/model", s, "qianfan");
  expect(s.model).toBe("glm-5.2");
  dispatchCommand("/model", s, "qianfan");
  expect(s.model).toBe("deepseek-v4-pro");
});

it("/model glm-5.2 对 qianfan 合法", () => {
  const s = sess();
  const r = dispatchCommand("/model glm-5.2", s, "qianfan");
  expect(r.handled).toBe(true);
  expect(s.model).toBe("glm-5.2");
});

it("/model glm-5.2 对 deepseek 非法,给出可选列表且不改动当前模型", () => {
  const s = sess();
  const r = dispatchCommand("/model glm-5.2", s, "deepseek");
  expect(s.model).toBe("deepseek-v4-pro");
  expect(r.output).toContain("deepseek-v4-pro");
  expect(r.output).toContain("deepseek-v4-flash");
});

it("省略 provider 参数时按 deepseek 处理(向后兼容)", () => {
  const s = sess();
  dispatchCommand("/model", s);
  expect(s.model).toBe("deepseek-v4-flash");
});
```

- [ ] **Step 6: 跑测试确认失败**

Run: `npm test -- src/commands/commands.test.ts`
Expected: FAIL — 当前 `/model` 硬编码两值 toggle 且不做非法校验,qianfan 循环/glm 校验用例不通过。

- [ ] **Step 7: 实现 `/model` provider-aware**

`src/commands/commands.ts` 顶部加:
```ts
import type { Provider } from "../config/profiles.js";
import { MODELS_BY_PROVIDER } from "../config/profiles.js";
```
签名与 `"model"` 分支改成:
```ts
export function dispatchCommand(input: string, session: Session, provider: Provider = "deepseek"): CommandResult {
  ...
  switch (cmd) {
    case "model": {
      const known = MODELS_BY_PROVIDER[provider] ?? MODELS_BY_PROVIDER.deepseek;
      if (arg) {
        if (!known.includes(arg)) {
          return { handled: true, output: `✗ ${provider} 下未知模型「${arg}」,可选:${known.join(" / ")}` };
        }
        session.setModel(arg);
        return { handled: true, output: `已切换模型:${arg}` };
      }
      const idx = known.indexOf(session.model);
      const next = known[(idx + 1) % known.length] ?? known[0]!;
      session.setModel(next);
      return { handled: true, output: `已切换模型:${next}` };
    }
```
(其余 `switch` 分支不动。)

- [ ] **Step 8: 跑测试确认通过**

Run: `npm test -- src/commands/commands.test.ts`
Expected: PASS(含既有 `/model` 两条旧用例——它们不传 provider,走 deepseek 默认列表,行为与之前一致)

- [ ] **Step 9: 接入调用点(`repl.ts` + `index.ts`)**

`src/repl.ts` 顶部加 `import type { Provider } from "./config/profiles.js";`,`ReplDeps` 接口加一个可选字段:
```ts
  // 当前生效 provider 的实时读取(/model 按 provider 校验/循环用);省略 = 按 deepseek 处理。
  getProvider?: () => Provider;
```
`runRepl` 内 `dispatchCommand` 调用改成:
```ts
    const cmd = dispatchCommand(line, deps.session, deps.getProvider?.());
```
`src/index.ts` 两处调用点:第一处(Ink UI 的 `runCommand` 闭包内,原 `return dispatchCommand(line, session);`)改成:
```ts
          return dispatchCommand(line, session, cfg.provider);
```
第二处(`runRepl({...})` 构造对象字面量处)加一行:
```ts
        getProvider: () => cfg.provider,
```

- [ ] **Step 10: 类型检查 + 全量回归**

Run: `npm run typecheck`
Expected: 无类型错误。
Run: `npm test`
Expected: 全量通过。

- [ ] **Step 11: 提交**

```bash
git add src/config/profiles.ts src/config/profiles.test.ts src/commands/commands.ts src/commands/commands.test.ts src/repl.ts src/index.ts
git commit -m "feat(model): /model 按 provider 校验+循环,千帆新增支持 glm-5.2"
```

---

### Task 11: `/account` 加账户支持选择 provider

**Files:**
- Modify: `src/tui/app/types.ts:73`(`addAccount` 字段签名)
- Modify: `src/tui/app/App.tsx`(`runAddAccount`,加一步 provider 询问)
- Modify: `src/index.ts`(`addAccount` 函数签名 + `meta` 构造,基于 Task 9 已修好的版本上再加 `provider` 参数)
- Modify: `src/i18n/messages/zh.ts` / `en.ts`(新增 `ui.account.providerPrompt`)
- Test: `src/tui/app/App.test.tsx`

**Interfaces:**
- Consumes: Task 9 的 `addAccount` 内已同步 `cfg.baseUrl/model/provider` + `session.setModel`(本任务只加一个新参数,不改已有同步逻辑)
- Produces:`addAccount(key: string, name?: string, provider: Provider = "deepseek")`;新账户(`cur` 为 `undefined` 时)按传入的 `provider` 取 `DEFAULTS[provider]`,不再硬编码 `deepseek`。UI 侧粘贴 key 之后、起名之前,多问一句"这是哪个 provider 的 key"。

- [ ] **Step 1: 写失败测试**

在 `src/tui/app/App.test.tsx` 追加(参考文件里已有的 `/account 无账户` 测试写法,`makeDeps`/`delay`/`ENTER` 等 helper 沿用文件顶部既有定义):
```tsx
it("/account 添加账户:key → provider → name,provider 透传给 addAccount", async () => {
  let seenProvider: string | undefined;
  const { stdin } = render(
    <App {...makeDeps({
      listAccounts: () => [],
      addAccount: async (key, name, provider) => { seenProvider = provider; return { ok: true, name: name ?? "default" }; },
    })} />,
  );
  for (const ch of "/account") stdin.write(ch);
  await delay();
  stdin.write("\r"); // 无账户,直接进添加
  await delay();
  for (const ch of "qf-key") stdin.write(ch);
  stdin.write("\r"); // 粘贴 key
  await delay();
  for (const ch of "qianfan") stdin.write(ch);
  stdin.write("\r"); // 选 provider
  await delay();
  stdin.write("\r"); // 起名(留空用默认)
  await delay();
  expect(seenProvider).toBe("qianfan");
});

it("/account 添加账户:provider 打错字 → 静默回退 deepseek", async () => {
  let seenProvider: string | undefined;
  const { stdin } = render(
    <App {...makeDeps({
      listAccounts: () => [],
      addAccount: async (key, name, provider) => { seenProvider = provider; return { ok: true, name: name ?? "default" }; },
    })} />,
  );
  for (const ch of "/account") stdin.write(ch);
  await delay();
  stdin.write("\r");
  await delay();
  for (const ch of "qf-key") stdin.write(ch);
  stdin.write("\r");
  await delay();
  for (const ch of "not-a-provider") stdin.write(ch);
  stdin.write("\r");
  await delay();
  stdin.write("\r");
  await delay();
  expect(seenProvider).toBe("deepseek");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/tui/app/App.test.tsx`
Expected: FAIL —— 当前 `runAddAccount` 没有 provider 询问这一步,第二次 `stdin.write` 的内容会被当成"起名"而非"选 provider",`seenProvider` 收到 `undefined`。

- [ ] **Step 3: 类型层加 `provider` 参数**

`src/tui/app/types.ts:73` 改成:
```ts
  addAccount?: (key: string, name?: string, provider?: Provider) => Promise<{ ok: boolean; name?: string; reason?: string }>; // 校验+持久化+激活
```
若该文件顶部尚未 import `Provider`,补一行 `import type { Provider } from "../../config/profiles.js";`。

- [ ] **Step 4: `App.tsx` 加 provider 询问步骤**

`src/tui/app/App.tsx` 的 `runAddAccount` 改成:
```tsx
  const runAddAccount = async () => {
    const key = (await askLine(t("ui.account.pastePrompt"))).trim();
    if (!key) { pushItem({ id: nextId(), kind: "notice", text: t("ui.notice.cancelled") }); return; }
    const providerInput = (await askLine(t("ui.account.providerPrompt"))).trim().toLowerCase();
    const provider = (["deepseek", "volcengine", "qianfan"].includes(providerInput) ? providerInput : "deepseek") as Provider;
    const name = (await askLine(t("ui.account.namePrompt"))).trim();
    pushItem({ id: nextId(), kind: "notice", text: t("ui.account.validating") });
    const r = await deps.addAccount?.(key, name || undefined, provider);
    pushItem({ id: nextId(), kind: "notice", text: r?.ok ? t("ui.account.added", r.name ?? "") : t("ui.account.addFailed", reasonText(r?.reason)) });
    setStatus(deps.getStatus());
  };
```
若文件顶部尚未 import `Provider` 类型,补一行 `import type { Provider } from "../../config/profiles.js";`。

- [ ] **Step 5: i18n 新 key**

`src/i18n/messages/zh.ts`,`"ui.account.pastePrompt"` 行后插入:
```ts
  "ui.account.providerPrompt": "这个 key 属于哪个 provider?(deepseek/volcengine/qianfan,回车默认 deepseek):",
```
`src/i18n/messages/en.ts` 对应位置:
```ts
  "ui.account.providerPrompt": "Which provider is this key for? (deepseek/volcengine/qianfan, Enter for deepseek): ",
```

- [ ] **Step 6: `index.ts` 的 `addAccount` 加 `provider` 参数**

在 Task 9 已修好(含 `cfg.baseUrl/model/provider` 同步 + `session.setModel`)的基础上,函数签名与 `meta` 构造改成:
```ts
  const addAccount = async (key: string, name?: string, provider: Provider = "deepseek"): Promise<{ ok: boolean; name?: string; reason?: string }> => {
    const targetName = name?.trim() || nextAccountName();
    const cur = profilesCfg.profiles[targetName];
    const meta = cur
      ? { provider: cur.provider, baseUrl: cur.baseUrl, model: cur.model }
      : { provider, ...DEFAULTS[provider] };
    const v = await validateCredential({ baseUrl: meta.baseUrl, key, provider: meta.provider });
    if (!v.ok) return { ok: false, reason: v.reason };
    const { cfg: nc } = await persistKey(profilesCfg, targetName, meta, key, kc, { preferKeychain: keychainAvailable() });
    profilesCfg = { ...nc, onboardingComplete: true };
    await saveProfiles(keyFile, profilesCfg);
    cfg.apiKey = key; cfg.baseUrl = meta.baseUrl; cfg.model = meta.model; cfg.provider = meta.provider; keySource = `profile:${targetName}`;
    session.setModel(meta.model);
    return { ok: true, name: targetName };
  };
```
(只有 `provider: "deepseek" as const` 硬编码改成参数 `provider`、`...DEFAULTS.deepseek` 改成 `...DEFAULTS[provider]`;Task 9 已加的同步四行保留不动。)

- [ ] **Step 7: 跑测试确认通过 + 回归既有 `/account` 用例**

Run: `npm test -- src/tui/app/App.test.tsx`
Expected: PASS(新增 2 条 + 既有全部 `/account` 相关用例,包括"无账户:直接进入粘贴引导"和"i18n:账户粘贴引导跟随 locale"——这两条只断言第一屏文案,不受新增步骤影响)

- [ ] **Step 8: 类型检查 + 全量回归**

Run: `npm run typecheck`
Expected: 无类型错误。
Run: `npm test`
Expected: 全量通过。

- [ ] **Step 9: 提交**

```bash
git add src/tui/app/types.ts src/tui/app/App.tsx src/index.ts src/i18n/messages/zh.ts src/i18n/messages/en.ts src/tui/app/App.test.tsx
git commit -m "feat(account): /account 加账户支持选择 provider(不再硬编码 deepseek)"
```

---

### Task 12: `/logout` 文案修正(反映"删整个 profile"而非"只清 key")

**Files:**
- Modify: `src/index.ts`(`logout` 分支的输出字符串)
- Modify: `src/i18n/messages/zh.ts` / `en.ts`(`cmd.logout` 帮助文案)

**Interfaces:**
- Produces:`/logout` 的确认文案与 `cmd.logout` 帮助文案准确描述"删除整个 profile(provider+baseUrl+model+key)",不再暗示"只清了 key"。

- [ ] **Step 1: 改 `/logout` 输出**

搜 `已清除账户「\${active}」的 key`,改成:
```ts
            return { handled: true, output: `✓ 已删除账户「${active}」(整个 profile:provider/baseUrl/model/key 一起删)。本会话仍用当前凭证;重启后需 /login 或切到其它账户。` };
```

- [ ] **Step 2: 改 `cmd.logout` 帮助文案**

`src/i18n/messages/zh.ts`:
```ts
  "cmd.logout": "删除当前账户(整个 profile,不止 key)",
```
`src/i18n/messages/en.ts`:
```ts
  "cmd.logout": "Remove the current account (the whole profile, not just the key)",
```

- [ ] **Step 3: 确认无既有测试依赖旧文案**

Run: `grep -rn "已清除账户\|cmd.logout" src --include=*.test.ts --include=*.test.tsx`
Expected: 无匹配(若有匹配,说明有测试断言旧字符串,需要一并更新,再继续)。

- [ ] **Step 4: 全量回归**

Run: `npm test`
Expected: 全量通过(纯文案改动,不影响任何断言)。

- [ ] **Step 5: 提交**

```bash
git add src/index.ts src/i18n/messages/zh.ts src/i18n/messages/en.ts
git commit -m "fix(account): /logout 文案改为准确描述删整个 profile,非只清 key"
```

---

## Self-Review

- **Spec 覆盖(Task 1-8)**:§2.1→Task1;§2.2(凭证来源,复用现有 profile/headless 路径,无需新 env 源)→Task3 说明,无独立 env 任务(正确,因 env 源已被整体移除);§2.3(探针)→Task2;§2.4(onboarding)→Task4+Task5;§2.5(反思节奏)→Task6(仅注释,逻辑已通用,Task9 进一步把判定源头从快照改活值);§5 实测 gate→Task8;§4 单测→Task1/2/4/5 内联 + Task7 全量。§3 YAGNI 项(分档表/Anthropic 协议/额度追踪/运行时使用限制校验)均无对应任务(正确,故意不做)。
- **Spec 覆盖(Task 9-12,对应 spec §8 四点缺口)**:缺口 1(`/account` 不问 provider)→Task11;缺口 2(状态不完全同步)→Task9;缺口 3(`/model` provider-unaware,不支持 glm-5.2)→Task10;缺口 4(`/logout` 文案不符)→Task12。四点与 spec §8 编号一一对应,无遗漏、无多余。
- **占位符扫描**:无 TBD/TODO;每个 code step 给全代码与确切命令、预期输出。
- **类型一致**:`Provider`(Task1)被 Task2/3/4/9/10/11 消费,命名一致;`validateCredential` 签名不变;i18n key 名在引用处与定义处一致(`onboard.provider.qianfan`/`onboard.key.help.qianfan`/`ui.account.providerPrompt`);`dispatchCommand` 新签名(Task10 定义 `provider: Provider = "deepseek"`)与 `repl.ts`/`index.ts` 两处调用点(Task10 Step9)、既有 `commands.test.ts` 用例(省略 provider 参数按 deepseek 处理)保持兼容;`addAccount` 新签名(Task11 定义 `provider: Provider = "deepseek"`)与 `types.ts`(Task11 Step3)、`App.tsx`(Task11 Step4)三处一致;Task11 的 `meta` 构造依赖 Task9 已加的同步逻辑,顺序上 Task9 必须先于 Task11 执行。
