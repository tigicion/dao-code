# 道家 onboarding 重做 实现计划(子项目 A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把首启重做成「欢迎屏即配置」的连续 Ink 道家流——banner 下原地走 语言→Provider→key→信任,配完输入框激活;交互路径不碰 readline。

**Architecture:** 新增独立 `runOnboarding` Ink render(复用 `Welcome.tsx` banner + 手写 `Select` + 四个 step 组件),收集并持久化凭证/语言/信任后卸载;`index.ts` 在首启交互 TTY 路径用它替换 readline `runKeyWizard`;主 App 以 `skipBanner` 挂载。`App.tsx` 核心与凭证流不动。

**Tech Stack:** TypeScript ESM(`.js` 后缀)、React + Ink、vitest + ink-testing-library、i18n(B 的 `t()`/`setLang`)。

**Spec:** `docs/design/specs/2026-06-28-daoist-onboarding-design.md`(commit eac2048)

## Global Constraints

- 交互路径**绝不创建 readline**(readline create+close 破坏 stdin → Ink 接管即 EOF 退出);非交互/headless 保留现有 readline 兜底。
- 复用 `Welcome.tsx`(太极/词标/朱印名句),**名句/落款/太极保留中文**(品牌),不译。
- onboarding 全文案走 `t(key)`(B);语言步选定即 `setLang` 整屏切。
- 凭证流不变:onboarding 返回 `ResolvedCredential`,下游 `cfg={apiKey,baseUrl,model}` 沿用。
- 步骤集与顺序:① 语言 ② Provider(deepseek/volcengine) ③ key+校验 ④ 信任。
- ESM `.js` import 后缀;ink-testing 发键码 UP=`\x1B[A` DOWN=`\x1B[B` ENTER=`\r`。
- commit message 不加任何 AI 署名。

---

### Task 1: Welcome `skipFooter` + App `skipBanner`

**Files:**
- Modify: `src/tui/Welcome.tsx`(props + 页脚 Box)、`src/tui/app/types.ts`(AppDeps)、`src/tui/app/App.tsx`(814/820 两处 Welcome)
- Test: `src/tui/Welcome.test.tsx`(新建)、`src/tui/app/App.test.tsx`(加用例)

**Interfaces:**
- Produces:`Welcome` 接受 `skipFooter?: boolean`(真→不渲染页脚两栏);`AppDeps.skipBanner?: boolean`(真→App 不渲染 `<Welcome>`)。

- [ ] **Step 1: 写失败测试** — 新建 `src/tui/Welcome.test.tsx`:

```tsx
import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Welcome } from "./Welcome.js";

const props = {
  info: { model: "deepseek-v4-pro", thinking: "max", cwd: "/x/y/z", version: "0.2.0", branch: "main" },
  caps: { tier: "none" as const, isTTY: true, columns: 80 },
  bg: "dark" as const,
  maxim: { text: "上善若水", chapter: 8 },
};

describe("Welcome skipFooter", () => {
  it("renders the footer (快速开始) by default", () => {
    const { lastFrame } = render(<Welcome {...props} />);
    expect(lastFrame()).toContain("快速开始");
  });
  it("hides the footer when skipFooter", () => {
    const { lastFrame } = render(<Welcome {...props} skipFooter />);
    expect(lastFrame()).not.toContain("快速开始");
    expect(lastFrame()).toContain("DAO CODE"); // banner 仍在
  });
});
```

- [ ] **Step 2: 跑确认失败**

Run: `npm test -- src/tui/Welcome.test.tsx`
Expected: FAIL — skipFooter 不被识别,页脚仍渲染。

- [ ] **Step 3: 实现 Welcome skipFooter**

`src/tui/Welcome.tsx` 函数签名加 `skipFooter`:
```tsx
export function Welcome({
  info, caps, bg, maxim, skipFooter,
}: {
  info: WelcomeInfo; caps: Capabilities; bg: Background; maxim: Maxim; skipFooter?: boolean;
}) {
```
把页脚那段(`{/* 页脚两栏 */}` 的 `<Box marginTop={1} flexDirection={narrow ? "column" : "row"}>…</Box>` 整块)包成条件渲染:
```tsx
      {!skipFooter && (
      <Box marginTop={1} flexDirection={narrow ? "column" : "row"}>
        {/* …原页脚内容不变… */}
      </Box>
      )}
```
(注意:仅包裹页脚 Box,banner/logo 部分不动。)

- [ ] **Step 4: AppDeps + App 抑制 banner**

`src/tui/app/types.ts` 的 `AppDeps` 加:
```ts
  skipBanner?: boolean;
```
`src/tui/app/App.tsx:814-816`(`items.length === 0` 分支)与 `:819-821`(Static `item.kind === "welcome"`)两处 `<Welcome>`,用 `deps.skipBanner` 守卫:
```tsx
      {items.length === 0 && !deps.skipBanner ? (
        <Welcome info={deps.welcome.info} caps={deps.welcome.caps} bg={bg} maxim={deps.welcome.maxim} />
      ) : null}
```
```tsx
          item.kind === "welcome" ? (
            deps.skipBanner ? null : <Welcome key={item.id} info={deps.welcome.info} caps={deps.welcome.caps} bg={bg} maxim={deps.welcome.maxim} />
          ) : (
```

- [ ] **Step 5: App 测试**

`src/tui/app/App.test.tsx` 加用例(用其现有 `makeDeps`):
```tsx
  it("skips the welcome banner when skipBanner is set", () => {
    const { lastFrame } = render(<App {...makeDeps({ skipBanner: true })} />);
    expect(lastFrame()).not.toContain("DAO CODE");
  });
```

- [ ] **Step 6: 跑测试 + typecheck**

Run: `npm test -- src/tui/Welcome.test.tsx src/tui/app/App.test.tsx`
Expected: PASS
Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 7: 提交**

```bash
git add src/tui/Welcome.tsx src/tui/Welcome.test.tsx src/tui/app/types.ts src/tui/app/App.tsx src/tui/app/App.test.tsx
git commit -m "feat(onboarding): Welcome skipFooter + App skipBanner"
```

> 注意 Step 3 代码块里 `woc` 是排版噪声,实现时删除——仅保留 `{!skipFooter && (` 开头。

---

### Task 2: `Select` 手写单选组件

**Files:**
- Create: `src/tui/onboarding/Select.tsx`
- Test: `src/tui/onboarding/Select.test.tsx`

**Interfaces:**
- Produces:
```ts
export interface SelectItem { label: string; value: string }
export function Select(props: {
  items: SelectItem[]; initialIndex?: number; bg: Background;
  onSelect: (value: string) => void;
}): JSX.Element;
```
↑↓ 环绕移动、Enter 触发 `onSelect(当前 value)`;当前项用 `▸` + jade 高亮。

- [ ] **Step 1: 写失败测试** — `src/tui/onboarding/Select.test.tsx`:

```tsx
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { Select } from "./Select.js";

const DOWN = "\x1B[B", UP = "\x1B[A", ENTER = "\r";
const items = [{ label: "中文", value: "zh" }, { label: "English", value: "en" }];
const delay = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("Select", () => {
  it("highlights initialIndex and selects it on Enter", async () => {
    const onSelect = vi.fn();
    const { stdin, lastFrame } = render(<Select items={items} initialIndex={1} bg="dark" onSelect={onSelect} />);
    expect(lastFrame()).toContain("▸ English");
    stdin.write(ENTER); await delay();
    expect(onSelect).toHaveBeenCalledWith("en");
  });
  it("moves with arrows and wraps", async () => {
    const onSelect = vi.fn();
    const { stdin, lastFrame } = render(<Select items={items} bg="dark" onSelect={onSelect} />);
    expect(lastFrame()).toContain("▸ 中文");
    stdin.write(DOWN); await delay();
    expect(lastFrame()).toContain("▸ English");
    stdin.write(DOWN); await delay();           // 环绕回第一项
    expect(lastFrame()).toContain("▸ 中文");
    stdin.write(UP); await delay();              // 上箭头环绕到末项
    expect(lastFrame()).toContain("▸ English");
    stdin.write(ENTER); await delay();
    expect(onSelect).toHaveBeenCalledWith("en");
  });
});
```

- [ ] **Step 2: 跑确认失败**

Run: `npm test -- src/tui/onboarding/Select.test.tsx`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现 `src/tui/onboarding/Select.tsx`**

```tsx
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Background } from "../background.js";
import { semHex } from "../theme.js";

export interface SelectItem { label: string; value: string }

export function Select({
  items, initialIndex = 0, bg, onSelect,
}: {
  items: SelectItem[]; initialIndex?: number; bg: Background; onSelect: (value: string) => void;
}) {
  const [idx, setIdx] = useState(Math.min(Math.max(initialIndex, 0), items.length - 1));
  useInput((_ch, key) => {
    if (key.downArrow) setIdx((i) => (i + 1) % items.length);
    else if (key.upArrow) setIdx((i) => (i - 1 + items.length) % items.length);
    else if (key.return) onSelect(items[idx]!.value);
  });
  const c = (sem: Parameters<typeof semHex>[0]) => semHex(sem, bg);
  return (
    <Box flexDirection="column">
      {items.map((it, i) => (
        <Text key={it.value} color={i === idx ? c("jade") : c("ink")}>
          {i === idx ? "▸ " : "  "}{it.label}
        </Text>
      ))}
    </Box>
  );
}
```

- [ ] **Step 4: 跑确认通过**

Run: `npm test -- src/tui/onboarding/Select.test.tsx`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/tui/onboarding/Select.tsx src/tui/onboarding/Select.test.tsx
git commit -m "feat(onboarding): 手写 Select 单选组件(↑↓ 环绕 + Enter)"
```

---

### Task 3: onboarding i18n 键(zh/en)

**Files:**
- Modify: `src/i18n/messages/zh.ts`、`src/i18n/messages/en.ts`
- Test: `src/i18n/i18n.test.ts`(已断 key 对称;加断新键存在)

**Interfaces:**
- Produces 新键(zh/en 同集):`onboard.lang.title`、`onboard.provider.title`、`onboard.provider.deepseek`、`onboard.provider.volcengine`、`onboard.key.title`、`onboard.key.help.deepseek`、`onboard.key.help.volcengine`、`onboard.key.validating`、`onboard.trust.title`、`onboard.step.lang`、`onboard.step.provider`、`onboard.step.key`、`onboard.step.trust`、`onboard.progress`。

- [ ] **Step 1: 写失败测试** — `src/i18n/i18n.test.ts` 加:

```ts
it("has the onboarding step keys in both langs", () => {
  setLang("zh"); expect(t("onboard.provider.volcengine")).toBe("火山引擎(Coding Plan)");
  setLang("en"); expect(t("onboard.provider.volcengine")).toBe("Volcengine (Coding Plan)");
  setLang("en"); expect(t("onboard.progress", 2, 4)).toBe("Step 2 / 4");
});
```

- [ ] **Step 2: 跑确认失败**

Run: `npm test -- src/i18n/i18n.test.ts`
Expected: FAIL — 键缺失(返回 key 本身)。

- [ ] **Step 3: 加键到 `src/i18n/messages/zh.ts`**(在 `onboard.abortNoKey` 之后):

```ts
  "onboard.lang.title": "选择语言 / Language",
  "onboard.provider.title": "选择模型来源 / Provider",
  "onboard.provider.deepseek": "DeepSeek(官方 API)",
  "onboard.provider.volcengine": "火山引擎(Coding Plan)",
  "onboard.key.title": "粘贴 API key",
  "onboard.key.help.deepseek": "获取 key:https://platform.deepseek.com/api_keys",
  "onboard.key.help.volcengine": "获取 key:火山方舟控制台 → API Key 管理",
  "onboard.key.validating": "正在校验 key…",
  "onboard.trust.title": "信任此文件夹?",
  "onboard.step.lang": "语言",
  "onboard.step.provider": "来源",
  "onboard.step.key": "密钥",
  "onboard.step.trust": "信任",
  "onboard.progress": "第 {0} 步 / 共 {1}",
```

- [ ] **Step 4: 加键到 `src/i18n/messages/en.ts`**(同位置):

```ts
  "onboard.lang.title": "Select language / 语言",
  "onboard.provider.title": "Select model provider",
  "onboard.provider.deepseek": "DeepSeek (official API)",
  "onboard.provider.volcengine": "Volcengine (Coding Plan)",
  "onboard.key.title": "Paste your API key",
  "onboard.key.help.deepseek": "Get a key: https://platform.deepseek.com/api_keys",
  "onboard.key.help.volcengine": "Get a key: Volcengine Ark console → API Key management",
  "onboard.key.validating": "Validating key…",
  "onboard.trust.title": "Trust this folder?",
  "onboard.step.lang": "Language",
  "onboard.step.provider": "Provider",
  "onboard.step.key": "Key",
  "onboard.step.trust": "Trust",
  "onboard.progress": "Step {0} / {1}",
```

- [ ] **Step 5: 跑确认通过(含 key 对称用例)**

Run: `npm test -- src/i18n/i18n.test.ts`
Expected: PASS（含既有 zh/en 键对称断言）。

- [ ] **Step 6: 提交**

```bash
git add src/i18n/messages/zh.ts src/i18n/messages/en.ts src/i18n/i18n.test.ts
git commit -m "feat(onboarding): 新增 onboarding i18n 键(zh/en)"
```

---

### Task 4: LanguageStep + ProviderStep

**Files:**
- Create: `src/tui/onboarding/steps/LanguageStep.tsx`、`src/tui/onboarding/steps/ProviderStep.tsx`
- Test: `src/tui/onboarding/steps/steps_select.test.tsx`

**Interfaces:**
- Consumes:Task2 `Select`、Task3 键、B `setLang`/`t`、`DEFAULTS`/`Provider`。
- Produces:
```ts
export function LanguageStep(p: { bg: Background; initial: Lang; onPick: (l: Lang) => void }): JSX.Element;
export function ProviderStep(p: { bg: Background; onPick: (provider: Provider) => void }): JSX.Element;
```
LanguageStep 选定即 `setLang(l)` 再 `onPick(l)`(整屏即时切);ProviderStep `onPick("deepseek"|"volcengine")`。

- [ ] **Step 1: 写失败测试** — `src/tui/onboarding/steps/steps_select.test.tsx`:

```tsx
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { LanguageStep } from "./LanguageStep.js";
import { ProviderStep } from "./ProviderStep.js";
import { setLang, getLang } from "../../../i18n/i18n.js";

const DOWN = "\x1B[B", ENTER = "\r";
const delay = (ms = 30) => new Promise((r) => setTimeout(r, ms));
beforeEach(() => setLang("en"));

describe("LanguageStep", () => {
  it("defaults to `initial` and setLang+onPick on Enter", async () => {
    const onPick = vi.fn();
    const { stdin, lastFrame } = render(<LanguageStep bg="dark" initial="zh" onPick={onPick} />);
    expect(lastFrame()).toContain("▸ 中文");
    stdin.write(ENTER); await delay();
    expect(onPick).toHaveBeenCalledWith("zh");
    expect(getLang()).toBe("zh");
  });
});

describe("ProviderStep", () => {
  it("picks volcengine after one DOWN", async () => {
    const onPick = vi.fn();
    const { stdin } = render(<ProviderStep bg="dark" onPick={onPick} />);
    stdin.write(DOWN); await delay(); stdin.write(ENTER); await delay();
    expect(onPick).toHaveBeenCalledWith("volcengine");
  });
});
```

- [ ] **Step 2: 跑确认失败**

Run: `npm test -- src/tui/onboarding/steps/steps_select.test.tsx`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现 `LanguageStep.tsx`**

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { Background } from "../../background.js";
import { semHex } from "../../theme.js";
import { Select } from "../Select.js";
import { setLang, t, type Lang } from "../../../i18n/i18n.js";

export function LanguageStep({ bg, initial, onPick }: { bg: Background; initial: Lang; onPick: (l: Lang) => void }) {
  return (
    <Box flexDirection="column">
      <Text color={semHex("dim", bg)}>{t("onboard.lang.title")}</Text>
      <Select
        bg={bg}
        initialIndex={initial === "en" ? 1 : 0}
        items={[{ label: "中文", value: "zh" }, { label: "English", value: "en" }]}
        onSelect={(v) => { setLang(v as Lang); onPick(v as Lang); }}
      />
    </Box>
  );
}
```

- [ ] **Step 4: 实现 `ProviderStep.tsx`**

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { Background } from "../../background.js";
import { semHex } from "../../theme.js";
import { Select } from "../Select.js";
import { t } from "../../../i18n/i18n.js";
import type { Provider } from "../../../config/profiles.js";

export function ProviderStep({ bg, onPick }: { bg: Background; onPick: (provider: Provider) => void }) {
  return (
    <Box flexDirection="column">
      <Text color={semHex("dim", bg)}>{t("onboard.provider.title")}</Text>
      <Select
        bg={bg}
        items={[
          { label: t("onboard.provider.deepseek"), value: "deepseek" },
          { label: t("onboard.provider.volcengine"), value: "volcengine" },
        ]}
        onSelect={(v) => onPick(v as Provider)}
      />
    </Box>
  );
}
```

- [ ] **Step 5: 跑确认通过**

Run: `npm test -- src/tui/onboarding/steps/steps_select.test.tsx`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/tui/onboarding/steps/LanguageStep.tsx src/tui/onboarding/steps/ProviderStep.tsx src/tui/onboarding/steps/steps_select.test.tsx
git commit -m "feat(onboarding): LanguageStep + ProviderStep"
```

---

### Task 5: KeyStep(粘贴 + 校验 + 持久化)

**Files:**
- Create: `src/tui/onboarding/steps/KeyStep.tsx`
- Test: `src/tui/onboarding/steps/KeyStep.test.tsx`

**Interfaces:**
- Consumes:Task3 键、`ValidateResult`(`../../../config/validate_key.js`)、`Provider`/`Profile`、B `t`。
- Produces:
```ts
export function KeyStep(p: {
  bg: Background; provider: Provider; meta: { baseUrl: string; model: string };
  validate: (c: { baseUrl: string; key: string; provider: Provider }) => Promise<ValidateResult>;
  onDone: (key: string) => void;   // 校验通过
  onAbort: () => void;             // 空输入放弃
}): JSX.Element;
```
状态:输入态(显示 provider 专属 help + 已输入掩码)→ Enter 空=onAbort;非空→"校验中…"→失败显 reason 回输入态;成功→onDone(key)。粘贴用 `usePaste` 追加,键入用 `useInput`(backspace 删尾、return 提交)。

- [ ] **Step 1: 写失败测试** — `src/tui/onboarding/steps/KeyStep.test.tsx`:

```tsx
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { KeyStep } from "./KeyStep.js";
import { setLang } from "../../../i18n/i18n.js";

const ENTER = "\r";
const delay = (ms = 30) => new Promise((r) => setTimeout(r, ms));
beforeEach(() => setLang("en"));
const meta = { baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro" };

describe("KeyStep", () => {
  it("validates a typed key then onDone", async () => {
    const validate = vi.fn(async () => ({ ok: true } as const));
    const onDone = vi.fn(); const onAbort = vi.fn();
    const { stdin, lastFrame } = render(
      <KeyStep bg="dark" provider="deepseek" meta={meta} validate={validate} onDone={onDone} onAbort={onAbort} />,
    );
    expect(lastFrame()).toContain("platform.deepseek.com");
    stdin.write("sk-abc"); await delay();
    stdin.write(ENTER); await delay(50);
    expect(validate).toHaveBeenCalledWith({ baseUrl: meta.baseUrl, key: "sk-abc", provider: "deepseek" });
    expect(onDone).toHaveBeenCalledWith("sk-abc");
  });
  it("shows the reason and stays on failure, not onDone", async () => {
    const validate = vi.fn(async () => ({ ok: false, reason: "invalid" } as const));
    const onDone = vi.fn(); const onAbort = vi.fn();
    const { stdin, lastFrame } = render(
      <KeyStep bg="dark" provider="deepseek" meta={meta} validate={validate} onDone={onDone} onAbort={onAbort} />,
    );
    stdin.write("sk-bad"); await delay(); stdin.write(ENTER); await delay(50);
    expect(onDone).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("invalid");
  });
  it("empty Enter aborts", async () => {
    const validate = vi.fn(); const onDone = vi.fn(); const onAbort = vi.fn();
    const { stdin } = render(
      <KeyStep bg="dark" provider="deepseek" meta={meta} validate={validate as any} onDone={onDone} onAbort={onAbort} />,
    );
    stdin.write(ENTER); await delay();
    expect(onAbort).toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑确认失败**

Run: `npm test -- src/tui/onboarding/steps/KeyStep.test.tsx`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现 `KeyStep.tsx`**

```tsx
import React, { useState } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import type { Background } from "../../background.js";
import { semHex } from "../../theme.js";
import { t } from "../../../i18n/i18n.js";
import type { Provider } from "../../../config/profiles.js";
import type { ValidateResult } from "../../../config/validate_key.js";

const REASON_KEY: Record<string, string> = {
  invalid: "validate.reason.invalid", unreachable: "validate.reason.unreachable", http: "validate.reason.http",
};

export function KeyStep({
  bg, provider, meta, validate, onDone, onAbort,
}: {
  bg: Background; provider: Provider; meta: { baseUrl: string; model: string };
  validate: (c: { baseUrl: string; key: string; provider: Provider }) => Promise<ValidateResult>;
  onDone: (key: string) => void; onAbort: () => void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const c = (sem: Parameters<typeof semHex>[0]) => semHex(sem, bg);
  const helpKey = provider === "volcengine" ? "onboard.key.help.volcengine" : "onboard.key.help.deepseek";

  const submit = async (k: string) => {
    if (!k) { onAbort(); return; }
    setBusy(true); setErr(null);
    const v = await validate({ baseUrl: meta.baseUrl, key: k, provider });
    setBusy(false);
    if (v.ok) onDone(k);
    else setErr(t(REASON_KEY[v.reason] ?? "validate.reason.fail"));
  };

  usePaste((text) => { if (!busy) setKey((s) => s + text.replace(/\s+/g, "")); });
  useInput((ch, k) => {
    if (busy) return;
    if (k.return) { void submit(key); return; }
    if (k.backspace || k.delete) { setKey((s) => s.slice(0, -1)); return; }
    if (ch && !k.ctrl && !k.meta) setKey((s) => s + ch);
  });

  return (
    <Box flexDirection="column">
      <Text color={c("dim")}>{t("onboard.key.title")}</Text>
      <Text color={c("dim")}>{t(helpKey)}</Text>
      <Text color={c("ink")}>{"› "}{key ? "•".repeat(Math.min(key.length, 32)) : ""}</Text>
      {busy ? <Text color={c("dim")}>{t("onboard.key.validating")}</Text> : null}
      {err ? <Text color={c("vermilion")}>{"✗ "}{err}</Text> : null}
    </Box>
  );
}
```
> `semHex` 语义色为 `ink|jade|vermilion|dim|gold`(见 `src/tui/theme.ts`);错误用 `vermilion`(朱红)。

- [ ] **Step 4: 跑确认通过**

Run: `npm test -- src/tui/onboarding/steps/KeyStep.test.tsx`
Expected: PASS（三用例)

- [ ] **Step 5: 提交**

```bash
git add src/tui/onboarding/steps/KeyStep.tsx src/tui/onboarding/steps/KeyStep.test.tsx
git commit -m "feat(onboarding): KeyStep(粘贴/键入 → 校验 → 成功/重试/放弃)"
```

---

### Task 6: TrustStep

**Files:**
- Create: `src/tui/onboarding/steps/TrustStep.tsx`
- Test: `src/tui/onboarding/steps/TrustStep.test.tsx`

**Interfaces:**
- Produces:
```ts
export function TrustStep(p: { bg: Background; root: string; onDecide: (trusted: boolean) => void }): JSX.Element;
```
显示 `root` + `t("trust.prompt")` 说明;按 `y`→onDecide(true);其它键(`n`/Enter)→onDecide(false)。

- [ ] **Step 1: 写失败测试** — `src/tui/onboarding/steps/TrustStep.test.tsx`:

```tsx
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { TrustStep } from "./TrustStep.js";
import { setLang } from "../../../i18n/i18n.js";

const delay = (ms = 30) => new Promise((r) => setTimeout(r, ms));
beforeEach(() => setLang("en"));

describe("TrustStep", () => {
  it("y → trusted true", async () => {
    const onDecide = vi.fn();
    const { stdin, lastFrame } = render(<TrustStep bg="dark" root="/repo/x" onDecide={onDecide} />);
    expect(lastFrame()).toContain("/repo/x");
    stdin.write("y"); await delay();
    expect(onDecide).toHaveBeenCalledWith(true);
  });
  it("n → trusted false", async () => {
    const onDecide = vi.fn();
    const { stdin } = render(<TrustStep bg="dark" root="/repo/x" onDecide={onDecide} />);
    stdin.write("n"); await delay();
    expect(onDecide).toHaveBeenCalledWith(false);
  });
});
```

- [ ] **Step 2: 跑确认失败**

Run: `npm test -- src/tui/onboarding/steps/TrustStep.test.tsx`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现 `TrustStep.tsx`**

```tsx
import React from "react";
import { Box, Text, useInput } from "ink";
import type { Background } from "../../background.js";
import { semHex } from "../../theme.js";
import { t } from "../../../i18n/i18n.js";

export function TrustStep({ bg, root, onDecide }: { bg: Background; root: string; onDecide: (trusted: boolean) => void }) {
  useInput((ch) => {
    if (ch === "y" || ch === "Y") onDecide(true);
    else onDecide(false);
  });
  const c = (sem: Parameters<typeof semHex>[0]) => semHex(sem, bg);
  return (
    <Box flexDirection="column">
      <Text color={c("dim")}>{t("onboard.trust.title")}</Text>
      <Text color={c("ink")}>{root}</Text>
      <Text color={c("dim")}>{t("trust.prompt", root).split("\n").slice(2).join(" ")}</Text>
      <Text color={c("dim")}>{"[y/N]"}</Text>
    </Box>
  );
}
```
> `t("trust.prompt", root)` 含多行警告;此处复用其说明文字(取第 3 行起)。若觉杂糅,可新增专用 `onboard.trust.body` 键——但为复用既有文案,先按上式;实现时若拆分不自然,加 `onboard.trust.body` 到 zh/en(Task3 同款),并改用它。

- [ ] **Step 4: 跑确认通过**

Run: `npm test -- src/tui/onboarding/steps/TrustStep.test.tsx`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/tui/onboarding/steps/TrustStep.tsx src/tui/onboarding/steps/TrustStep.test.tsx
git commit -m "feat(onboarding): TrustStep(y/N 信任决定)"
```

---

### Task 7: Onboarding 编排 + run.tsx

**Files:**
- Create: `src/tui/onboarding/Onboarding.tsx`、`src/tui/onboarding/run.tsx`
- Test: `src/tui/onboarding/Onboarding.test.tsx`

**Interfaces:**
- Consumes:Task1 `Welcome(skipFooter)`、Task4-6 steps、`DEFAULTS`/`Provider`/`Profile`/`ResolvedCredential`、`ValidateResult`、`Lang`、`WelcomeInfo`/`Capabilities`/`Background`/`Maxim`。
- Produces(与 spec §2.1 一致):
```ts
export interface OnboardingDeps {
  welcome: { info: WelcomeInfo; caps: Capabilities; bg: Background; maxim: Maxim };
  detectedLang: Lang;
  validate: (c: { baseUrl: string; key: string; provider: Provider }) => Promise<ValidateResult>;
  persist: (provider: Provider, meta: { baseUrl: string; model: string }, key: string) => Promise<{ resolved: ResolvedCredential }>;
  writeLang: (lang: Lang) => Promise<void>;
  trustCurrent: () => Promise<void>;
  workspaceRoot: string;
}
export interface OnboardingResult { resolved: ResolvedCredential; lang: Lang; trusted: boolean }
export function Onboarding(p: OnboardingDeps & { onFinish: (r: OnboardingResult | null) => void }): JSX.Element;
export function runOnboarding(deps: OnboardingDeps): Promise<OnboardingResult | null>;
```
状态机 `language→provider→key→trust→done`;顶部恒显 `<Welcome … skipFooter />` + 进度 `t("onboard.progress", n, 4)`;各步用 Task4-6 组件;key 成功后 `persist` 得 resolved;trust 决定后 `writeLang(lang)` + (trusted 时 `trustCurrent()`) → `onFinish({resolved,lang,trusted})`;空 key → `onFinish(null)`。

- [ ] **Step 1: 写失败测试** — `src/tui/onboarding/Onboarding.test.tsx`:

```tsx
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { Onboarding } from "./Onboarding.js";
import { setLang } from "../../i18n/i18n.js";

const DOWN = "\x1B[B", ENTER = "\r";
const delay = (ms = 40) => new Promise((r) => setTimeout(r, ms));
beforeEach(() => setLang("en"));

const welcome = {
  info: { model: "deepseek-v4-pro", thinking: "max", cwd: "/x", version: "0.2.0", branch: "main" },
  caps: { tier: "none" as const, isTTY: true, columns: 80 }, bg: "dark" as const, maxim: { text: "上善若水", chapter: 8 },
};

function deps(over = {}) {
  return {
    welcome, detectedLang: "en" as const,
    validate: vi.fn(async () => ({ ok: true } as const)),
    persist: vi.fn(async (provider, meta, key) => ({ resolved: { key, provider, baseUrl: meta.baseUrl, model: meta.model, source: "profile:default" } })),
    writeLang: vi.fn(async () => {}), trustCurrent: vi.fn(async () => {}), workspaceRoot: "/x",
    ...over,
  };
}

describe("Onboarding state machine", () => {
  it("runs lang→provider→key→trust and finishes with the result", async () => {
    const onFinish = vi.fn(); const d = deps();
    const { stdin, lastFrame } = render(<Onboarding {...d} onFinish={onFinish} />);
    expect(lastFrame()).toContain("DAO CODE");         // banner 在
    expect(lastFrame()).not.toContain("快速开始");      // 页脚不显
    stdin.write(ENTER); await delay();                  // 语言=English(默认)
    stdin.write(ENTER); await delay();                  // provider=deepseek(默认)
    stdin.write("sk-x"); await delay(); stdin.write(ENTER); await delay(60); // key 校验通过
    stdin.write("y"); await delay();                    // 信任
    expect(d.writeLang).toHaveBeenCalledWith("en");
    expect(d.trustCurrent).toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ lang: "en", trusted: true }));
    expect(onFinish.mock.calls[0][0].resolved.key).toBe("sk-x");
  });
  it("aborts (null) on empty key", async () => {
    const onFinish = vi.fn(); const d = deps();
    const { stdin } = render(<Onboarding {...d} onFinish={onFinish} />);
    stdin.write(ENTER); await delay(); stdin.write(ENTER); await delay(); // lang, provider
    stdin.write(ENTER); await delay();                  // 空 key → 放弃
    expect(onFinish).toHaveBeenCalledWith(null);
  });
});
```

- [ ] **Step 2: 跑确认失败**

Run: `npm test -- src/tui/onboarding/Onboarding.test.tsx`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现 `Onboarding.tsx`**

```tsx
import React, { useState } from "react";
import { Box, Text } from "ink";
import { Welcome } from "../Welcome.js";
import { semHex } from "../theme.js";
import { t, type Lang } from "../../i18n/i18n.js";
import { DEFAULTS, type Provider, type ResolvedCredential } from "../../config/profiles.js";
import type { ValidateResult } from "../../config/validate_key.js";
import type { WelcomeInfo } from "../banner.js";
import type { Capabilities } from "../capabilities.js";
import type { Background } from "../background.js";
import type { Maxim } from "../maxim.js";
import { LanguageStep } from "./steps/LanguageStep.js";
import { ProviderStep } from "./steps/ProviderStep.js";
import { KeyStep } from "./steps/KeyStep.js";
import { TrustStep } from "./steps/TrustStep.js";

export interface OnboardingDeps {
  welcome: { info: WelcomeInfo; caps: Capabilities; bg: Background; maxim: Maxim };
  detectedLang: Lang;
  validate: (c: { baseUrl: string; key: string; provider: Provider }) => Promise<ValidateResult>;
  persist: (provider: Provider, meta: { baseUrl: string; model: string }, key: string) => Promise<{ resolved: ResolvedCredential }>;
  writeLang: (lang: Lang) => Promise<void>;
  trustCurrent: () => Promise<void>;
  workspaceRoot: string;
}
export interface OnboardingResult { resolved: ResolvedCredential; lang: Lang; trusted: boolean }

type Step = "language" | "provider" | "key" | "trust";
const STEP_NO: Record<Step, number> = { language: 1, provider: 2, key: 3, trust: 4 };

export function Onboarding({ welcome, detectedLang, validate, persist, writeLang, trustCurrent, workspaceRoot, onFinish }: OnboardingDeps & { onFinish: (r: OnboardingResult | null) => void }) {
  const { bg } = welcome;
  const [step, setStep] = useState<Step>("language");
  const [lang, setLang_] = useState<Lang>(detectedLang);
  const [provider, setProvider] = useState<Provider>("deepseek");
  const [resolved, setResolved] = useState<ResolvedCredential | null>(null);
  const c = (sem: Parameters<typeof semHex>[0]) => semHex(sem, bg);
  const meta = { baseUrl: DEFAULTS[provider].baseUrl, model: DEFAULTS[provider].model };

  const finishTrust = async (trusted: boolean) => {
    await writeLang(lang);
    if (trusted) await trustCurrent();
    onFinish({ resolved: resolved!, lang, trusted });
  };

  return (
    <Box flexDirection="column">
      <Welcome info={welcome.info} caps={welcome.caps} bg={bg} maxim={welcome.maxim} skipFooter />
      <Box marginTop={1}><Text color={c("jade")}>{t("onboard.progress", STEP_NO[step], 4)}</Text></Box>
      <Box marginTop={1}>
        {step === "language" ? (
          <LanguageStep bg={bg} initial={detectedLang} onPick={(l) => { setLang_(l); setStep("provider"); }} />
        ) : step === "provider" ? (
          <ProviderStep bg={bg} onPick={(p) => { setProvider(p); setStep("key"); }} />
        ) : step === "key" ? (
          <KeyStep bg={bg} provider={provider} meta={meta} validate={validate}
            onDone={async (k) => { const { resolved: r } = await persist(provider, meta, k); setResolved(r); setStep("trust"); }}
            onAbort={() => onFinish(null)} />
        ) : (
          <TrustStep bg={bg} root={workspaceRoot} onDecide={(tr) => { void finishTrust(tr); }} />
        )}
      </Box>
    </Box>
  );
}
```

- [ ] **Step 4: 实现 `run.tsx`**

```tsx
import React from "react";
import { render } from "ink";
import { Onboarding, type OnboardingDeps, type OnboardingResult } from "./Onboarding.js";

export async function runOnboarding(deps: OnboardingDeps): Promise<OnboardingResult | null> {
  return await new Promise<OnboardingResult | null>((resolve) => {
    let done = false;
    const app = render(
      <Onboarding {...deps} onFinish={(r) => { if (done) return; done = true; app.unmount(); resolve(r); }} />,
      { interactive: true } as unknown as Parameters<typeof render>[1],
    );
  });
}
```

- [ ] **Step 5: 跑确认通过 + typecheck**

Run: `npm test -- src/tui/onboarding/Onboarding.test.tsx`
Expected: PASS（两用例)
Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add src/tui/onboarding/Onboarding.tsx src/tui/onboarding/run.tsx src/tui/onboarding/Onboarding.test.tsx
git commit -m "feat(onboarding): Onboarding 状态机编排 + runOnboarding render"
```

---

### Task 8: index.ts 接线(替换 readline wizard + skipBanner)

**Files:**
- Modify: `src/index.ts`(首启分支 265-300 区、信任段 309-329、runInkApp 调用 1185)

**Interfaces:**
- Consumes:Task7 `runOnboarding`/`OnboardingDeps`;现有 `validateCredential`、`persistKey`、`addTrusted`、`saveProfiles`、`readUserLang`、`DEFAULTS`、`getLang`、`writeUserLang`(见下)。

- [ ] **Step 1: 在交互首启分支用 runOnboarding 取代 readline wizard**

定位 `src/index.ts` 首启分支(`if (!resolved) { if (process.stdin.isTTY) { … runKeyWizard … }`,约 264-287)。该 `process.stdin.isTTY` 分支再加条件 `&& !argvPrompt`(headless 仍走文本/退出)。把 `runKeyWizard(...)` 整段替换为:
```ts
      const ob = await runOnboarding({
        welcome,                       // 与 runInkApp 同一束;若此处尚未构造,见 Step 2
        detectedLang: getLang(),       // setLang(resolveLang(...)) 已在前(B 接线)
        validate: (c) => validateCredential(c),
        persist: async (provider, meta, key) => {
          const { cfg } = await persistKey(profilesCfg, "default", { provider, ...meta }, key, kc, { preferKeychain: keychainAvailable() });
          profilesCfg = { ...cfg, onboardingComplete: true };
          await saveProfiles(keyFile, profilesCfg);
          return { resolved: { key, provider, baseUrl: meta.baseUrl, model: meta.model, source: "profile:default" } };
        },
        writeLang: (lang) => writeUserLang(lang),
        trustCurrent: () => addTrusted(workspaceRoot),
        workspaceRoot,
      });
      if (!ob) { write(`${t("onboard.abortNoKey")}\n`); process.exit(1); }
      resolved = ob.resolved;
      trustProject = ob.trusted;       // onboarding 内已处理信任,跳过后续 readline 信任问答
      firstRun = true;
```
> `welcome` 束的构造:确认 `welcome`(`{info,caps,bg,maxim}`)在该处可见;若它在 runInkApp 调用附近才构造,把其构造上移到首启分支之前(纯数据,无副作用)。

- [ ] **Step 2: 新增 `writeUserLang` 到 i18n,并跳过 readline 信任问答**

`src/i18n/i18n.ts` 加(与 `readUserLang` 对称,合并写顶层 lang,保留其它字段):
```ts
export async function writeUserLang(lang: Lang): Promise<void> {
  const file = path.join(os.homedir(), ".dao", "settings.json");
  let obj: Record<string, unknown> = {};
  try { obj = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>; } catch { /* 新建 */ }
  obj.lang = lang;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(obj, null, 2));
}
```
信任段(约 313-329):因 onboarding 已设 `trustProject`,把交互 readline 信任问答的 `if (process.stdin.isTTY && !argvPrompt)` 分支限定为**非首启**(`!firstRun`)——首启时 onboarding 已处理,不重复问:
```ts
  if (!trustProject) {
    if (process.stdin.isTTY && !argvPrompt && !firstRun) {
      // …原 readline 信任问答…
    } else if (!process.stdin.isTTY || argvPrompt) {
      process.stderr.write(`${t("trust.nonTty")}\n`);
    }
  }
```

- [ ] **Step 3: runInkApp 传 skipBanner**

`src/index.ts:1185` 的 `runInkApp({ … })` deps 加:
```ts
        skipBanner: firstRun,
```

- [ ] **Step 4: i18n writeUserLang 单测**

`src/i18n/i18n.test.ts` 加(用临时 HOME 或 mock fs 不便时,最少断函数存在且 lang 合法值写入——若测 fs 成本高,可断 `writeUserLang` 为函数且不抛):
```ts
it("writeUserLang is callable", async () => {
  const { writeUserLang } = await import("./i18n.js");
  expect(typeof writeUserLang).toBe("function");
});
```

- [ ] **Step 5: 跑全量 + typecheck**

Run: `npm test`
Expected: 全绿（非交互/headless 仍走文本兜底;既有 onboarding 路径测试不回归)。
Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add src/index.ts src/i18n/i18n.ts src/i18n/i18n.test.ts
git commit -m "feat(onboarding): index 首启走 runOnboarding(替换 readline wizard)+ skipBanner + writeUserLang"
```

---

### Task 9: 全量回归 + 构建 + 手动 e2e 自查

**Files:** 无新增。

- [ ] **Step 1: 全量单测 + typecheck + build**

Run: `npm test && npm run typecheck && npm run build`
Expected: 全绿、构建成功。

- [ ] **Step 2: 手动首启自查(删档后真跑)**

```bash
mv ~/.dao/config.json ~/.dao/config.json.bak 2>/dev/null; npm run dev
```
Expected:欢迎屏 banner(太极/朱印/名句)出现,下方原地走 语言→Provider→key→信任;配完输入框激活,**无 readline、无 banner 重影、无"渲一帧即退"**。中文机器默认中文步骤,`DAO_LANG=en` 默认英文。
跑完恢复:`mv ~/.dao/config.json.bak ~/.dao/config.json 2>/dev/null`。

- [ ] **Step 3:(无代码改动则无 commit)**

---

## Self-Review

- **Spec 覆盖**:§2.1 目录与接口→T2/T4/T5/T6/T7;§2.2 步骤流→T7 编排 + T4-6;§2.3 接线→T8;§2.4 放弃/降级→T8(abort null + headless 限定);§2.5 App 改动→T1;§3 i18n→T3 + 各步走 t();§5 测试→各任务内联 + T9 全量。
- **占位符扫描**:无 TBD;每个 code step 给完整组件/测试代码与命令。KeyStep 错误色已敲定 `vermilion`(theme.ts 实证);TrustStep 文案复用给了回退(加 `onboard.trust.body`),非占位。
- **类型一致**:`OnboardingDeps`/`OnboardingResult`/`runOnboarding`(T7)与 T8 消费一致;`Select`(T2)props 与 T4 用法一致;`persist(provider, meta, key)` 签名 T7 定义、T8 实现一致;`skipFooter`(T1)/`skipBanner`(T1)与 T7/T8 用法一致;i18n 键(T3)与 T4-7 调用一致。
- **关键风险**:两段顺序 Ink render 的 stdin 交接 + 不碰 readline,由 T8(交互路径只调 runOnboarding/runInkApp)+ T9 手动 e2e 兜底验证。
