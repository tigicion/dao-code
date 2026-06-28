# i18n 展示层 — 设计定稿(子项目 B)

> 给 DAO 的【关键路径 UI 文案】做中英双语:启动按系统 locale 检测语言(检测不到默认英文),onboarding / 首启引导 / 目录信任 / 凭证报错 / Ink 欢迎屏页脚 跟随语言切换。**不碰模型输出语言**(系统提示词「跟随用户最新消息语言」一行不改),**不译全量 UI**(~976 条只动几十条关键路径),道家美学元素(名句/落款/太极)保留中文作为品牌。

定稿日期 2026-06-28。三件套(初次登录重做)的**子项目 B**,顺序 C→B→A;C(火山 provider)已合入 master。B 为 A(道家 onboarding 重做)提供 locale 设施。

---

## 0. 一句话

新增 `src/i18n/`(`resolveLang` + `t()` + zh/en 两套扁平字典),启动定一次语言;把 `index.ts`/`auth_wizard.ts`/`Welcome.tsx`/`tips.ts` 里的关键路径中文串换成 `t(key)`;名句/太极不动;模型输出语言不动。

## 1. 动机与现状

英文用户当前看到的是硬编码中文的首启与欢迎屏(运维脚本式),而模型输出语言其实已正确(系统提示词已「跟随用户最新消息语言」)。所以 B 的目标**纯展示层**:让英文用户的**界面文案**也用英文。

调研结论(已查代码):
- **无现成 i18n 设施**(`App.tsx` 的 `LANG` 是语法高亮映射、`bash_safety` 的 `locale` 是命令名,均无关)。B 是全新 greenfield。
- **唯一强制中文输出点**=`system_prompt.ts:202` 的隐式默认语言,用户已明确**不动**(跟随用户消息的行为没问题)。故 B **不碰系统提示词**。
- **用户级设置**已有 `~/.dao/settings.json`(`src/permissions/settings.ts` 解析 `permissions` 块),`lang` 字段挂这里。
- **关键路径文案**集中三处:`src/index.ts`、`src/config/auth_wizard.ts`、`src/tui/Welcome.tsx`(+`tips.ts`)。

## 2. 架构

### 2.1 新增 `src/i18n/`

```
src/i18n/
  i18n.ts        # resolveLang / setLang / getLang / t
  messages/zh.ts # 扁平字典:{ [key]: string }(含 tips 数组)
  messages/en.ts # 同 key 集,英文
  i18n.test.ts
```

```ts
export type Lang = "zh" | "en";

// 优先级:DAO_LANG(显式) > settingsLang > 系统 locale > 默认 "en"。
// 系统 locale 取 LC_ALL||LC_MESSAGES||LANG 的首段,zh* → zh,其余 → en。
// DAO_LANG/settingsLang 只认 "zh"/"en"(及 "zh-CN"/"zh_CN" → zh);非法值忽略,继续向下。
export function resolveLang(
  env: Record<string, string | undefined>,
  settingsLang?: string,
): Lang;

let current: Lang = "en";
export function setLang(l: Lang): void;   // 启动定一次
export function getLang(): Lang;

// 查当前语言字典;缺 key → 返回 key 本身(开发期可见,不崩)。
// 占位:t("trust.prompt", root) 用 {0}{1}… 位置插值。
export function t(key: string, ...args: (string | number)[]): string;

// tips 是数组:randomTip 从当前语言的 tips 取一条(沿用现有 randomTip 语义)。
export function tips(): string[];
```

`resolveLang` 归一化规则:
- 取值小写;`startsWith("zh")` → `"zh"`;显式值若是合法 `en`/`zh` 直接用;系统 locale 非 zh 一律 `"en"`。
- 全空/无任何信号 → `"en"`(用户要求:检测不到默认英文)。

### 2.2 settings 读 `lang`(独立读取,不碰 permissions 链)

B 只需**用户级** `~/.dao/settings.json` 的顶层 `lang`(项目级不参与语言决策,避免仓库改用户界面语言)。**不改** `src/permissions/settings.ts` 的 `parseSettings`/合并链;而是在 i18n 模块里加一个独立函数:

```ts
// 读 ~/.dao/settings.json 顶层 lang 字段;文件缺失/损坏/无字段 → undefined(容错)。
export async function readUserLang(): Promise<string | undefined>;
```

在 `main()` 早期调用,结果传给 `resolveLang`。

### 2.3 接线(`src/index.ts main()` 开头)

在**任何 onboarding 输出之前**:

```ts
const settingsLang = await readUserLang();          // 读 ~/.dao/settings.json 顶层 lang,容错
setLang(resolveLang(process.env, settingsLang));
```

此后所有关键路径文案改用 `t(...)`。

### 2.4 替换清单(关键路径)

| 文件 | 串 | key 示例 |
|---|---|---|
| `index.ts:267` | 欢迎 + [1/2] DeepSeek API key | `onboard.welcome` / `onboard.step1` |
| `index.ts:122` | KEY_HELP(获取 key URL 行) | `key.help` |
| `index.ts:289-296` | 非交互缺 key 指引(4 行) | `key.missing.*` |
| `index.ts:307` | env 来源覆盖提示 | `key.envSource` |
| `index.ts:317` | [2/2] 目录信任 + 信任问答 | `trust.step2` / `trust.prompt` |
| `index.ts:322/324/327` | 已信任 / 已继续未信任 / 非 TTY 警告 | `trust.*` |
| `index.ts:330` | ✓ 设置完成,开始吧 | `onboard.done` |
| `auth_wizard.ts:29/31/34/37/41` | 粘 key / 放弃 / 校验中 / 重试 / 已存(钥匙串\|文件) | `wizard.*` |
| `auth_wizard.ts:5-9` | `REASON_TEXT`(invalid/unreachable/http) | `validate.reason.*` |
| `Welcome.tsx:104-130` | 页脚 模型/目录/快速开始 + 提示行 | `welcome.*` |
| `tips.ts` | 引导提示数组 | `tips()` |

**不动**:`Welcome.tsx` 的名句 `maxim`、落款 `DAO CODE`、太极 `taiji`、词标 `WORDMARK`(品牌/道家美学,保留中文/原样)。

## 3. 不做什么(YAGNI)

- 不译全量 ~976 条 UI(仅关键路径几十条)。
- 不做 `/lang` 运行时切换命令(启动定一次;改 settings/env 后重启生效)。
- 不碰系统提示词 / 模型输出语言。
- 不译名句/落款/太极。
- 不引入第三方 i18n 库(两套扁平字典 + 位置插值足够)。
- 项目级 settings 不参与语言决策(只用户级)。

## 4. 数据流

```
启动 → readUserLang(~/.dao/settings.json) ─┐
                                            ├→ resolveLang(env, settingsLang) → setLang(lang)
process.env(DAO_LANG / LC_*/LANG) ──────────┘
之后:t("onboard.welcome") → messages[getLang()]["onboard.welcome"]
```

## 5. 测试

- `i18n.test.ts`:
  - `resolveLang` 优先级:`DAO_LANG=zh` 压过 `settingsLang=en` 压过系统 `LANG=zh_CN`;
  - 归一化:`zh_CN.UTF-8`→zh、`en_US`→en、`fr_FR`→en、空→en、非法 `DAO_LANG=xx` 忽略后向下取;
  - `t()`:zh/en 各取对串;占位 `t("trust.prompt","/repo")` 正确插值;缺 key → 返回 key;
  - `tips()` 跟随 lang。
- **回归**:现有断言中文 onboarding/welcome 文案的测试(`auth_wizard.test.ts`、`Welcome`/`banner`/`maxim` 相关、以及任何断 onboarding 串的 `index` 级测试)改为显式 `setLang("zh")` 后断言、或改断 `t(key)`,保持全绿。实施时先跑全套定位受影响用例,逐一改。

## 6. 风险

| 项 | 风险 | 处置 |
|---|---|---|
| 受影响的既有测试范围 | 不确定哪些测试断了中文串 | 实施 Task 先 `npm test` 列出失败用例,逐一改为 setLang/t |
| settings.json lang 读取层 | 误改现有 permissions 合并链 | 独立 `readUserLang`,只读用户级顶层 lang,不动 permissions |
| Welcome.tsx 固化进 Static | 启动后 setLang 必须早于首次渲染 | setLang 在 `main()` 最早期、TUI 启动前 |

## 7. 与 A 的接口

A(道家 onboarding 重做)直接消费 `getLang()`/`t()`:首启「选语言」可写回 `~/.dao/settings.json` 的 `lang`;A 的 Ink 流文案全部走 `t(key)`。B 已把字典与解析备好,A 只增量加 key。
