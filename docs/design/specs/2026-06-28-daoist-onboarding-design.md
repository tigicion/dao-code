# 道家 onboarding 重做 — 设计定稿(子项目 A)

> 把首启从「readline 文本两步」重做成「**欢迎屏即配置**」的连续 Ink 道家流:首启时显示真正的欢迎屏 banner(太极+朱印+名句),banner 下方原地依次走 ① 语言 ② Provider ③ 粘 key+校验 ④ 目录信任,配完输入框激活。交互路径**彻底不碰 readline**(绕开 readline/Ink stdin 冲突);`App.tsx` 几乎不动(仍拿现成 cfg);onboarding 是独立可单测组件。

定稿日期 2026-06-28。三件套(初次登录重做)的**子项目 A**,顺序 C→B→A;C(火山 provider)、B(i18n 展示层)均已合入 master,A 消费两者。

---

## 0. 一句话

新增独立的 `runOnboarding` Ink render:复用 `Welcome.tsx` banner + 手写步骤组件(语言/Provider/key/信任),收集并持久化凭证与信任决定后卸载;`index.ts` 在首启交互 TTY 路径用它替换 readline `runKeyWizard`,主 App 以 `skipBanner` 挂载,形成「欢迎屏→配置→输入框」一条连续滚动。

## 1. 动机与现状

当前首启是 readline 文本两步(`index.ts:265-331` + `auth_wizard.ts`),与正式进入后的 Ink 道家欢迎屏(`Welcome.tsx`:太极/渐变词标/朱印名句)气质割裂——登录像运维脚本。A 消除割裂:**欢迎屏本身就是配置界面**。

已确认的架构约束与事实(读码):
- **readline 与 Ink 不能共用 stdin**(`index.ts:217-218`):readline 的 create+close 破坏 stdin,Ink 接管即收 EOF 退出。故 A 的交互路径绝不创建 readline。
- App 经 `deps.welcome={info,caps,bg,maxim}` 在 `App.tsx:815`(live)与 `:820`(Static items[0])两处渲染 `<Welcome>`。加 `skipBanner` 抑制两处即可。
- 首启 readline wizard 在 `index.ts:269` `runKeyWizard(...)`;主 App 在 `:1185` `runInkApp(...)`。
- App 现有手写选择器(`/account`/`/resume`:`useInput`+↑↓/Enter,无第三方 SelectInput)与 `inkAsk`/`askLine`——onboarding 步骤按同款手写。
- 凭证持久化与校验已就绪且 provider-aware:`validateCredential({baseUrl,key,provider})`(C)、`persistKey`、`DEFAULTS[provider]`。i18n `t()`/`setLang`/字典(B)。

## 2. 架构

### 2.1 新增 `src/tui/onboarding/`

```
src/tui/onboarding/
  Onboarding.tsx     # 编排:复用 Welcome banner + step 状态机;渲染当前步;完成 onDone(result)
  Select.tsx         # 手写 ↑↓/Enter 单选列表(道家配色,复用 theme)
  run.tsx            # runOnboarding(deps): Promise<OnboardingResult> —— render + waitUntilExit
  steps/
    LanguageStep.tsx # ① 中文/English,默认高亮=检测语言;选定 setLang + 待写 settings
    ProviderStep.tsx # ② DeepSeek / 火山引擎(volcengine);选定 → meta=DEFAULTS[provider]
    KeyStep.tsx      # ③ 粘 key(provider 专属 help URL)→ 校验中 → 失败重试 / 成功
    TrustStep.tsx    # ④ 目录信任 y/N(沿用 trust 语义)
  *.test.tsx
```

```ts
export interface OnboardingDeps {
  welcome: { info: WelcomeInfo; caps: Capabilities; bg: Background; maxim: Maxim }; // 复用 App 的同一束
  detectedLang: Lang;                 // B 的 resolveLang 结果,作语言步骤默认高亮
  validate: (c: { baseUrl: string; key: string; provider: Provider }) => Promise<ValidateResult>;
  persist: (name: string, meta: Pick<Profile,"provider"|"baseUrl"|"model">, key: string)
            => Promise<{ resolved: ResolvedCredential }>;        // 封 persistKey(钥匙串优先)
  writeLang: (lang: Lang) => Promise<void>;                       // 写 ~/.dao/settings.json 顶层 lang
  trustCurrent: () => Promise<void>;                              // addTrusted(workspaceRoot)
  workspaceRoot: string;
}
export interface OnboardingResult {
  resolved: ResolvedCredential;   // 选定 provider + 校验通过的凭证
  lang: Lang;                     // 已写入 settings 的语言
  trusted: boolean;               // 用户是否信任了当前目录
}
// 返回 null = 用户放弃(空 key);否则收集完成的结果。
export async function runOnboarding(deps: OnboardingDeps): Promise<OnboardingResult | null>;
```

### 2.2 步骤流(banner 之下原地推进)

`Onboarding.tsx` 顶部恒显 `<Welcome … skipFooter />`(banner=太极+词标+朱印名句,**不显页脚**——页脚的"模型/快速开始"区被当前步骤占据);其下渲染 `step` 对应组件 + 进度指示(`① ② ③ ④`,当前步高亮)。状态机:

```
language → provider → key → trust → done
```
- **① language**:`Select`[中文, English],默认 index=detectedLang;Enter → `setLang(选定)`(整个 onboarding 文案即时切)+ 记 lang(完成时 writeLang)。
- **② provider**:`Select`[DeepSeek, 火山引擎(coding plan)];Enter → meta=`DEFAULTS[provider]`。
- **③ key**:显示 provider 专属获取链接(deepseek/volcengine 各一);Ink `useInput` 收集粘贴 → "校验中…" → `validate(meta+key+provider)` → 失败显原因(`validate.reason.*`)可重试 / 成功 → `persist("default", meta, key)` 得 resolved。空输入=放弃(走 §2.4 放弃路径)。
- **④ trust**:显示 `workspaceRoot` + 信任说明;y → `trustCurrent()` 置 trusted=true;否则 trusted=false。
- **done**:`onDone({resolved, lang, trusted})` → run.tsx resolve → 卸载。

### 2.3 接线(`index.ts`)

首启(`!resolved`)且 `process.stdin.isTTY && !argvPrompt`:
```
setLang(resolveLang(process.env, await readUserLang()))   // 已是 B 接线;detectedLang=getLang()
const r = await runOnboarding({ welcome, detectedLang: getLang(), validate, persist, writeLang, trustCurrent, workspaceRoot });
profilesCfg = …(persist 内已落盘);resolved = r.resolved; trustProject = r.trusted; firstRun=true;
```
- 替换 `:269` 的 `runKeyWizard` 与 `:314-329` 的 readline 信任问答(交互路径合并进 onboarding)。
- `:1185` `runInkApp({ …, skipBanner: firstRun })` —— 首启已由 onboarding 显示并提交了 banner,主 App 不再重复。
- **凭证流不变**:onboarding 把解析好的 `resolved` 交回 index.ts,下游 `cfg={apiKey,baseUrl,model}` 与 20+ 处沿用照旧。

### 2.4 边界与降级

- **放弃 key**(空输入):`runOnboarding` resolve `null` → index.ts 打印 `onboard.abortNoKey` 并 `exit(1)`(沿用现语义)。
- **非交互/headless**(`-p`/管道/CI/非 TTY):**不进 onboarding**,保留现有 readline 纯文本兜底 + 缺 key 指引(`key.missing.*`)。
- **窄屏**:复用 `Welcome` 既有响应式(窄屏太极/词标上下堆叠);步骤区单列。

### 2.5 App 改动(最小)

- `AppDeps` 加 `skipBanner?: boolean`;`App.tsx:815/820` 两处 `<Welcome>` 在 `skipBanner` 时不渲染(banner 与 Static items[0] 均跳过)。
- `Welcome.tsx` 加 `skipFooter?: boolean` prop(onboarding 复用 banner 但不显页脚——页脚区被步骤占据;App 正常渲染时不传,行为不变)。其余不动。

## 3. i18n

onboarding 全部文案走 `t(key)`(B 机制)。新增 key(zh/en 同步):`onboard.lang.title`、`onboard.provider.title`、`onboard.provider.deepseek`、`onboard.provider.volcengine`、`onboard.key.title`、`onboard.key.help.deepseek`、`onboard.key.help.volcengine`、`onboard.key.validating`、`onboard.trust.title`、`onboard.step.{1..4}` 等;复用已有 `wizard.*`/`validate.reason.*`/`trust.*`/`onboard.*`。名句/落款/太极保留中文(品牌)。语言步骤选定即 `setLang`,后续步骤即时切。

## 4. 不做什么(YAGNI)

- 不把 onboarding 塞进 App 的"无凭证 bootstrap 态"(那会动全仓最复杂的 `App.tsx` 核心;本设计用独立 render + skipBanner,风险小一个数量级)。
- 不重做会话内 `/account`/`/login`/`/logout`(已是 Ink 选择器,保持)。
- 不支持 coding plan 里 DeepSeek 之外模型(沿用 C)。
- 不引入第三方 Ink select 库(手写,随codebase)。
- 不在非交互路径做图形 onboarding(readline 兜底)。

## 5. 测试

- `Select.test.tsx`:↑↓ 环绕、Enter 触发 onSelect、默认 index。
- `steps/*.test.tsx`(ink-testing-library,现仓已用):
  - LanguageStep:默认高亮=detectedLang;选 English → setLang("en") 且文案切英文。
  - ProviderStep:选 volcengine → meta=DEFAULTS.volcengine。
  - KeyStep:注入 fake validate——失败显 reason 可重试、成功调 persist;空输入=放弃态。
  - TrustStep:y→trustCurrent 调用、trusted=true;n→trusted=false。
- `Onboarding.test.tsx`:跑完整状态机(注入 deps),`onDone` 收到 `{resolved,lang,trusted}` 正确;banner 渲染、页脚不显。
- App:`skipBanner` 为真时不渲染 `<Welcome>`(快照/查询无太极),为假时照旧。
- 回归:全套绿;非交互路径(无 TTY)仍走 readline 兜底,既有 onboarding/headless 测试不回归。

## 6. 风险

| 项 | 风险 | 处置 |
|---|---|---|
| 两段顺序 Ink render(onboarding→App)stdin 交接 | 卸载/再挂载边界 stdin 状态 | onboarding 用 `render`+`waitUntilExit`,完成后 `unmount` 再挂 App;绝不创建 readline;实测首启端到端(挂载即退的老坑用 skipBanner+无 readline 规避) |
| banner 重影 | onboarding 与 App 都渲 Welcome | `skipBanner` 抑制 App 端;onboarding 提交一次 |
| 粘贴大 key 的 Ink 输入 | useInput/usePaste 处理粘贴 | 复用 App 既有 `usePaste` 经验 |
| 校验阻塞 UI | validate 网络往返 | "校验中…" 态 + 失败可重试;不卡死按键 |

## 7. 完成后(收尾,非本子项目阻塞)

A 落地后三件套主体完成。仍待:C 的真实 ARK key 实测 gate;i18n 全量延后项(`App.tsx` 主循环 UI、`index.ts:205` 迁移提示)。
