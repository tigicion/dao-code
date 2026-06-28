# 火山引擎 coding plan provider 实现计划(子项目 C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 DAO 接火山方舟 Coding Plan——新增 `volcengine` provider,使一个火山 ARK coding-plan key 能跑 DeepSeek v4 pro/flash。

**Architecture:** 火山 coding plan 的 `deepseek-v4-pro`/`deepseek-v4-flash` 串与 DAO 现用串完全一致,OpenAI 兼容协议,故 client/模型串零改动。改动仅 3 处:`profiles.ts`(provider 枚举 + DEFAULTS + `ARK_API_KEY` env 源)、`validate_key.ts`(按 provider 选校验探针)、两处 validate 调用点转发 provider。

**Tech Stack:** TypeScript (ESM, `.js` import 后缀)、vitest(`npm test` = `vitest run`)、注入式 fetch 假实现做单测。

**Spec:** `docs/design/specs/2026-06-28-volcengine-coding-plan-provider-design.md`(commit 74a9e9a)

## Global Constraints

- 模型串:火山与 DeepSeek 共用 `deepseek-v4-pro` / `deepseek-v4-flash`,**不引入分档表/映射层**,代码里既有写死模型串一行不动。
- 火山 base url:`https://ark.cn-beijing.volces.com/api/coding/v3`;鉴权 `Authorization: Bearer <key>`;OpenAI 兼容。
- ESM import 一律带 `.js` 后缀;测试文件 `*.test.ts` 与被测同目录。
- 来源串必须显式可呈现(env 源记为 `env:ARK_API_KEY`),杜绝静默计费。
- 交互式"选 provider"不在本计划(属子项目 A);C 的火山激活路径 = `ARK_API_KEY` env 源 + wizard 已能接受任意 provider 的 meta。
- commit message 不加任何 AI 署名。

---

### Task 1: provider 枚举 + DEFAULTS 加 volcengine

**Files:**
- Modify: `src/config/profiles.ts:5`(`Provider` union)、`src/config/profiles.ts:22-26`(`DEFAULTS`)
- Test: `src/config/profiles.test.ts`

**Interfaces:**
- Produces: `Provider` 含 `"volcengine"`;`DEFAULTS.volcengine = { baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3", model: "deepseek-v4-pro" }`

- [ ] **Step 1: 写失败测试**

在 `src/config/profiles.test.ts` 末尾追加:

```ts
describe("DEFAULTS.volcengine", () => {
  it("points at the coding-plan base url with deepseek-v4-pro as default model", () => {
    expect(DEFAULTS.volcengine).toEqual({
      baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
      model: "deepseek-v4-pro",
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/config/profiles.test.ts`
Expected: FAIL —`DEFAULTS.volcengine` 为 undefined(`toEqual` 不匹配),或 TS 报 `volcengine` 不在 `Provider` 上。

- [ ] **Step 3: 最小实现**

`src/config/profiles.ts:5` 改 union:

```ts
export type Provider = "deepseek" | "anthropic" | "openai" | "volcengine";
```

`src/config/profiles.ts:22-26` 的 `DEFAULTS` 加一项(`Record<Provider,…>` 会强制补全):

```ts
export const DEFAULTS: Record<Provider, { baseUrl: string; model: string }> = {
  deepseek:   { baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro" },
  volcengine: { baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3", model: "deepseek-v4-pro" },
  anthropic:  { baseUrl: "https://api.anthropic.com", model: "claude-opus-4-8" },
  openai:     { baseUrl: "https://api.openai.com/v1", model: "gpt-5" },
};
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `npm test -- src/config/profiles.test.ts`
Expected: PASS
Run: `npm run typecheck`
Expected: 无新增类型错误(确认加 union 没破坏别处穷尽性)。

- [ ] **Step 5: 提交**

```bash
git add src/config/profiles.ts src/config/profiles.test.ts
git commit -m "feat(provider): 新增 volcengine provider 与 coding-plan DEFAULTS"
```

---

### Task 2: `ARK_API_KEY` env 源

**Files:**
- Modify: `src/config/profiles.ts:67-91`(`resolveActive`)
- Test: `src/config/profiles.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `DEFAULTS.volcengine`
- Produces: `resolveActive` 在 `env.ARK_API_KEY` 存在时返回 `{ key, provider: "volcengine", baseUrl: env.ARK_BASE_URL ?? DEFAULTS.volcengine.baseUrl, model: env.ARK_MODEL ?? DEFAULTS.volcengine.model, source: "env:ARK_API_KEY" }`;优先级:`DEEPSEEK_API_KEY` > `ARK_API_KEY` > 激活 profile。

- [ ] **Step 1: 写失败测试**

在 `profiles.test.ts` 的 `describe("resolveActive", …)` 内追加:

```ts
it("resolves an ARK_API_KEY env override to the volcengine coding-plan provider", () => {
  const r = resolveActive(cfg, { ARK_API_KEY: "ark-xyz" });
  expect(r).toEqual({
    key: "ark-xyz",
    provider: "volcengine",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    model: "deepseek-v4-pro",
    source: "env:ARK_API_KEY",
  });
});

it("lets ARK_BASE_URL / ARK_MODEL override the volcengine defaults", () => {
  const r = resolveActive(cfg, { ARK_API_KEY: "ark-xyz", ARK_MODEL: "deepseek-v4-flash" });
  expect(r?.model).toBe("deepseek-v4-flash");
});

it("prefers DEEPSEEK_API_KEY over ARK_API_KEY when both are set", () => {
  const r = resolveActive(cfg, { DEEPSEEK_API_KEY: "sk-d", ARK_API_KEY: "ark-x" });
  expect(r?.source).toBe("env:DEEPSEEK_API_KEY");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/config/profiles.test.ts`
Expected: FAIL — ARK 分支不存在,返回 profile 源或 null。

- [ ] **Step 3: 最小实现**

`src/config/profiles.ts`,在 `resolveActive` 里 `DEEPSEEK_API_KEY` 分支之后、读 profile 之前插入:

```ts
  if (env.ARK_API_KEY) {
    return {
      key: env.ARK_API_KEY,
      provider: "volcengine",
      baseUrl: env.ARK_BASE_URL ?? DEFAULTS.volcengine.baseUrl,
      model: env.ARK_MODEL ?? DEFAULTS.volcengine.model,
      source: "env:ARK_API_KEY",
    };
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/config/profiles.test.ts`
Expected: PASS(含 Task 1 用例)

- [ ] **Step 5: 提交**

```bash
git add src/config/profiles.ts src/config/profiles.test.ts
git commit -m "feat(provider): ARK_API_KEY env 源解析为 volcengine(可被 DEEPSEEK_API_KEY 覆盖)"
```

---

### Task 3: 按 provider 选校验探针

**Files:**
- Modify: `src/config/validate_key.ts`
- Modify: `src/index.ts:274`、`src/index.ts:366`(两处 validate 调用转发 provider)
- Test: `src/config/validate_key.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Provider` 类型
- Produces: `validateCredential(cred: { baseUrl: string; key: string; provider?: Provider }, fetchImpl?)`——`provider === "volcengine"` 时打 `${baseUrl}/chat/completions`(POST,body `{ model: "deepseek-v4-flash", messages: [{ role: "user", content: "1" }], max_tokens: 1 }`),否则维持 `${baseUrl}/models`(GET)。两路判定一致:`res.ok`→ok;401/403→invalid;抛错→unreachable;其它→`http`。

- [ ] **Step 1: 写失败测试**

在 `src/config/validate_key.test.ts` 末尾追加:

```ts
describe("validateCredential · volcengine probe", () => {
  const ark = { baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3", key: "ark-x", provider: "volcengine" as const };

  it("probes chat/completions with a tiny POST for volcengine", async () => {
    let seenUrl = ""; let seenMethod = "";
    const fakeFetch = async (url: string, init?: { method?: string }) => {
      seenUrl = url; seenMethod = init?.method ?? "GET";
      return { ok: true, status: 200 } as Response;
    };
    const r = await validateCredential(ark, fakeFetch as unknown as typeof fetch);
    expect(r.ok).toBe(true);
    expect(seenUrl).toBe("https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions");
    expect(seenMethod).toBe("POST");
  });

  it("reports invalid on 401 for volcengine", async () => {
    const fakeFetch = async () => ({ ok: false, status: 401 } as Response);
    expect(await validateCredential(ark, fakeFetch as unknown as typeof fetch)).toEqual({ ok: false, reason: "invalid" });
  });

  it("reports unreachable when the volcengine probe throws", async () => {
    const fakeFetch = async () => { throw new Error("ENOTFOUND"); };
    expect(await validateCredential(ark, fakeFetch as unknown as typeof fetch)).toEqual({ ok: false, reason: "unreachable" });
  });

  it("still uses /models for deepseek (no provider given)", async () => {
    let seenUrl = "";
    const fakeFetch = async (url: string) => { seenUrl = url; return { ok: true, status: 200 } as Response; };
    await validateCredential({ baseUrl: "https://api.deepseek.com", key: "sk-x" }, fakeFetch as unknown as typeof fetch);
    expect(seenUrl).toBe("https://api.deepseek.com/models");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/config/validate_key.test.ts`
Expected: FAIL — volcengine 仍打 `/models`(GET),`seenUrl`/`seenMethod` 不匹配。

- [ ] **Step 3: 最小实现**

`src/config/validate_key.ts` 改签名与分支(顶部加 `import type { Provider } from "./profiles.js";`):

```ts
export async function validateCredential(
  cred: { baseUrl: string; key: string; provider?: Provider },
  fetchImpl: typeof fetch = fetch,
): Promise<ValidateResult> {
  let res: Response;
  try {
    if (cred.provider === "volcengine") {
      // coding plan 路径无 /models;用一发最小 chat 探针判鉴权(max_tokens:1)。
      res = await fetchImpl(`${cred.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cred.key}` },
        body: JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "1" }], max_tokens: 1 }),
      });
    } else {
      res = await fetchImpl(`${cred.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${cred.key}` },
      });
    }
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.ok) return { ok: true };
  if (res.status === 401 || res.status === 403) return { ok: false, reason: "invalid" };
  return { ok: false, reason: "http", status: res.status };
}
```

- [ ] **Step 4: 转发 provider 到两处调用点**

`src/index.ts:274`:

```ts
        validate: (c) => validateCredential({ ...c, provider: meta.provider }),
```

`src/index.ts:366`(`addAccount` 内):

```ts
    const v = await validateCredential({ baseUrl: meta.baseUrl, key, provider: meta.provider });
```

- [ ] **Step 5: 跑测试 + 类型检查确认通过**

Run: `npm test -- src/config/validate_key.test.ts`
Expected: PASS(含既有 deepseek 4 用例 + 新增 volcengine 4 用例)
Run: `npm run typecheck`
Expected: 无类型错误。

- [ ] **Step 6: 提交**

```bash
git add src/config/validate_key.ts src/config/validate_key.test.ts src/index.ts
git commit -m "feat(provider): 校验探针按 provider 选——volcengine 用 chat 探针(coding 路径无 /models)"
```

---

### Task 4: 全量回归 + 构建

**Files:** 无新增;验证整库未回归。

- [ ] **Step 1: 跑全量单测**

Run: `npm test`
Expected: 全绿(既有 deepseek 全链路 + 新增 volcengine 用例)。

- [ ] **Step 2: 构建二进制(若发布链路需要)**

Run: `npm run build`
Expected: 构建成功,无类型错误。

- [ ] **Step 3:(无改动则跳过提交)**

若 build 产物纳入版本管理则按既有约定提交;否则本任务无 commit。

---

### Task 5: 实测 gate(需真实 ARK coding-plan key — 用户提供后执行)

> 非自动化任务。用户已确认有 key,稍后提供。code+单测先合(Task 1–4),本任务在 key 到位后跑。

- [ ] **Step 1: 用 env 源启动火山**

```bash
ARK_API_KEY=<真实 ark key> npm run dev
```
Expected: 启动呈现来源 `env:ARK_API_KEY`,不报缺凭证。

- [ ] **Step 2: 校验探针验证**

观察启动/`/login` 时校验是否通过。若 `/chat/completions` 探针返回非 2xx,记录 status 调整(确认 coding plan 是否对 `max_tokens:1` 有特殊要求)。
Expected: 校验通过(✓ 已校验)。

- [ ] **Step 3: pro 跑一轮真实对话**

发一条普通消息,确认走 `https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions`、`deepseek-v4-pro` 正常返回。
Expected: 正常回复,无 404/401。

- [ ] **Step 4: flash 路径验证**

触发一次廉价子任务/分类器(或临时 `ARK_MODEL=deepseek-v4-flash` 启动),确认 `deepseek-v4-flash` 在火山下可调。
Expected: flash 调用成功。

- [ ] **Step 5: 计费/usage 记账**

确认 usage 日志正确记录火山调用(token/费用 sink 不串到 deepseek 账)。
Expected: 记账正确。

- [ ] **Step 6: 回填(如有偏差)**

若实测发现探针 body 或 model 串需微调,改对应代码 + 单测,提交:
```bash
git commit -m "fix(provider): 据火山实测回填校验探针/模型串"
```

---

## Self-Review

- **Spec 覆盖**:§2.1→Task1;§2.2(ARK env)→Task2;§2.3(探针)→Task3;§2.4(wizard 接受 volcengine meta)→由 Task3 转发 provider + 既有 `runKeyWizard`/`addAccount` 已用 meta 覆盖(无新代码);§5 实测 gate→Task5;§4 单测→Task1–3 内联 + Task4 全量。`ark-code-latest`/Anthropic 协议/分档表均在 spec §3 明确不做,无对应任务(正确)。
- **占位符扫描**:无 TBD/TODO;每个 code step 给全代码与确切命令、预期输出。
- **类型一致**:`validateCredential` 新签名 `{ baseUrl, key, provider? }` 在 Task3 定义,两处调用点同 Task 更新;`Provider` 含 volcengine(Task1)被 Task2/3 消费,命名一致。
