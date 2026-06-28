# i18n 展示层 实现计划(子项目 B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 DAO 的关键路径 UI 文案做中英双语——启动按系统 locale 检测语言(检测不到默认英文),onboarding/首启引导/目录信任/凭证报错/Ink 欢迎屏页脚跟随语言切换。

**Architecture:** 新增 `src/i18n/`(`resolveLang`+`setLang`+`t`+`tips`+`readUserLang`,两套扁平字典 zh/en),`main()` 早期定一次语言;把 `index.ts`/`auth_wizard.ts`/`Welcome.tsx`/`tips.ts` 的关键路径中文串换成 `t(key)`/`tips()`。名句/落款/太极与模型输出语言一律不动。

**Tech Stack:** TypeScript (ESM, `.js` import 后缀)、vitest(`npm test`)、注入式 env 做单测。

**Spec:** `docs/design/specs/2026-06-28-i18n-display-layer-design.md`(commit ae49d9f)

## Global Constraints

- 检测优先级:`DAO_LANG` > `~/.dao/settings.json` 顶层 `lang` > 系统 `LC_ALL`||`LC_MESSAGES`||`LANG`(首段 `zh*`→zh,其余→en)> 默认 `en`。
- 支持语言仅 `zh`/`en`;`DAO_LANG`/`lang` 只认 `zh`/`en`(及 `zh-CN`/`zh_CN`→zh),非法值忽略后继续向下。
- **不动**:系统提示词/模型输出语言;`Welcome.tsx` 的 `maxim`/`WORDMARK`/`taiji`/`DAO CODE` 落款;`/account` 选择器等非关键路径文案。
- **不做**:`/lang` 运行时命令;第三方 i18n 库;项目级 settings 参与语言决策。
- `t()` 缺 key → 返回 key 本身(不崩);占位用 `{0}{1}…` 位置插值。
- ESM import 带 `.js` 后缀;commit message 不加任何 AI 署名。

---

### Task 1: i18n 核心模块 + zh/en 字典

**Files:**
- Create: `src/i18n/i18n.ts`、`src/i18n/messages/zh.ts`、`src/i18n/messages/en.ts`
- Test: `src/i18n/i18n.test.ts`

**Interfaces:**
- Produces:
  - `type Lang = "zh" | "en"`
  - `resolveLang(env: Record<string,string|undefined>, settingsLang?: string): Lang`
  - `setLang(l: Lang): void` / `getLang(): Lang`
  - `t(key: string, ...args: (string|number)[]): string`
  - `tips(): string[]`
  - `readUserLang(): Promise<string|undefined>`(读 `~/.dao/settings.json` 顶层 `lang`,容错)

- [ ] **Step 1: 写失败测试** — 创建 `src/i18n/i18n.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { resolveLang, setLang, getLang, t, tips } from "./i18n.js";

describe("resolveLang", () => {
  it("DAO_LANG 压过 settings 压过系统 locale", () => {
    expect(resolveLang({ DAO_LANG: "zh", LANG: "en_US" }, "en")).toBe("zh");
  });
  it("settings.lang 压过系统 locale", () => {
    expect(resolveLang({ LANG: "en_US.UTF-8" }, "zh")).toBe("zh");
  });
  it("系统 locale zh* → zh,其余 → en", () => {
    expect(resolveLang({ LANG: "zh_CN.UTF-8" })).toBe("zh");
    expect(resolveLang({ LANG: "fr_FR.UTF-8" })).toBe("en");
  });
  it("LC_ALL 优先于 LANG", () => {
    expect(resolveLang({ LC_ALL: "zh_CN.UTF-8", LANG: "en_US" })).toBe("zh");
  });
  it("全空 → 默认 en", () => {
    expect(resolveLang({})).toBe("en");
  });
  it("非法 DAO_LANG 忽略后向下取系统 locale", () => {
    expect(resolveLang({ DAO_LANG: "xx", LANG: "zh_CN" })).toBe("zh");
  });
  it("DAO_LANG=zh-CN 归一化为 zh", () => {
    expect(resolveLang({ DAO_LANG: "zh-CN" })).toBe("zh");
  });
});

describe("t / setLang", () => {
  beforeEach(() => setLang("en"));
  it("按当前语言取串", () => {
    setLang("zh");
    expect(t("onboard.done")).toBe("✓ 设置完成,开始吧。");
    setLang("en");
    expect(t("onboard.done")).toBe("✓ Setup complete. Let's go.");
  });
  it("位置占位插值", () => {
    setLang("en");
    expect(t("key.envSource", "DEEPSEEK_API_KEY")).toContain("DEEPSEEK_API_KEY");
  });
  it("缺 key 返回 key 本身", () => {
    expect(t("no.such.key")).toBe("no.such.key");
  });
  it("tips 跟随语言且非空", () => {
    setLang("zh"); const zh = tips();
    setLang("en"); const en = tips();
    expect(zh.length).toBeGreaterThan(0);
    expect(en.length).toBe(zh.length);
    expect(zh[0]).not.toBe(en[0]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/i18n/i18n.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 写 `src/i18n/messages/zh.ts`**(zh 值逐字抄自现有源码)

```ts
export const zh: Record<string, string> = {
  "onboard.welcome": "欢迎使用 DAO CODE。先完成两步设置。",
  "onboard.step1": "[1/2] DeepSeek API key",
  "onboard.done": "✓ 设置完成,开始吧。",
  "key.help": "获取 key:https://platform.deepseek.com/api_keys",
  "key.missing.title": "未找到 DeepSeek API key。请用以下任一方式设置:",
  "key.missing.env": "  • 环境变量:export DEEPSEEK_API_KEY=sk-...",
  "key.missing.dotenv": "  • 项目 .env:在 .env 写一行 DEEPSEEK_API_KEY=sk-...",
  "key.missing.tty": "  • 在终端直接运行 dao(不接管道),会引导你粘贴并保存 key",
  "key.envSource": "※ 正在使用来自环境变量 {0} 的 key(覆盖了已存 profile)。",
  "trust.step2": "[2/2] 目录信任",
  "trust.prompt": "⚠ 此文件夹尚未信任:\n  {0}\ndao 会加载并可能执行它的项目配置(.dao/settings.json 与 hooks.json)。\n是否信任此文件夹?[y/N] ",
  "trust.trusted": "✓ 已信任此文件夹,加载其项目配置。",
  "trust.untrusted": "已继续(未信任):项目级 settings/hooks 不加载。之后可运行 `dao trust` 信任。",
  "trust.nonTty": "⚠ 未信任此目录的项目配置(.dao/settings.json 与 hooks.json 未加载)。确认安全后运行 `dao trust` 再启动以加载。",
  "wizard.paste": "请粘贴你的 key: ",
  "wizard.abandoned": "未输入 key,已放弃。",
  "wizard.validating": "正在校验 key…",
  "wizard.retry": "✗ {0},请重试(直接回车放弃)。",
  "wizard.storedKeychain": "✓ 已校验并存入系统钥匙串。",
  "wizard.storedFile": "✓ 已校验并保存(文件,权限 600)。",
  "validate.reason.invalid": "key 无效(鉴权被拒)",
  "validate.reason.unreachable": "网络不通,连不上 API",
  "validate.reason.http": "API 返回异常",
  "validate.reason.fail": "校验失败",
  "welcome.model": "模型 ",
  "welcome.ctx": "1M 上下文",
  "welcome.dir": "目录 ",
  "welcome.quickstart": "快速开始",
  "welcome.hint": "输入消息开始 · /help 命令 · @ 引用文件 · Esc 打断",
  "welcome.try": "试试 · ",
};

export const zhTips: string[] = [
  "输入 / 看全部命令 · @ 引用文件 · Shift+Tab 切权限模式 · Esc 打断",
  "新项目先 /init —— 扫描仓库生成 DAO.md,以后每次会话自动加载项目约定",
  "/skills 看可用技能;dao skill add <git> 装一套(如 superpowers),会自动适配工具名",
  "dao plugin add <git> 装插件 —— 一个插件可打包多个技能",
  "/context 看上下文占用;接近上限会自动压缩,也可手动 /compact",
  "/rewind 回退对话;/rewind <n> code 连文件一起回滚(影子 git,不动你的真实 git 提交)",
  "/restore 把工作区文件回退到上一个检查点;回退前会自动存档,可再找回",
  "/resume 列出历史会话并载入其上下文;/branch 存分支,/rename 命名会话",
  "/diff 看未提交改动;/review 让 dao 审一遍(也能审 gh PR);/security-review 查安全",
  "大任务:/goal <目标> 自主连续推进(直接带目标开跑);任务够大时会自动按研究→综合→实现→验证分阶段编排子代理",
  "/batch 把大改拆给多个 worktree 子代理并行做,各自一个分支",
  "/loop 5m <要做的事> 会话内周期跑;dao schedule 用本地 cron 定时跑",
  "Shift+Tab 循环权限模式:默认 → auto(AI 裁决) → 规划;接受编辑用 /mode acceptEdits 进",
  "/bypass 免审批(慎用);deny 规则与敏感路径(.ssh/.git/凭据…)仍会拦你",
  "dao 会自动记忆;/remember <事> 手动记一条,/memory 看用户/知识/项目三层记忆",
  "/effort 调思考强度(low/medium/high/max);/cost 看用量与缓存命中率",
  "粘贴大段文字会自动折叠成占位;/copy 复制最后一条回答到剪贴板",
  "卡住了?/debug 读会话日志诊断;/doctor 自检环境(API key / PATH / 二进制签名)",
  "可让 dao 派 explore 子代理彻底查、verify 子代理对抗性验证(它会真跑起来找反例)",
  "/simplify 清理刚改的代码(只质量不抓 bug);/skillify 把本次经验提炼成技能",
  "/tasks 看后台子代理;/mcp 看已连 MCP 服务器;/agents 看可用子代理类型",
  "运行中可继续输入,回车排队执行;Esc 随时优雅打断(模型流与 shell 一起停)",
];
```

- [ ] **Step 4: 写 `src/i18n/messages/en.ts`**(en 值为下列翻译)

```ts
export const en: Record<string, string> = {
  "onboard.welcome": "Welcome to DAO CODE. Two quick setup steps.",
  "onboard.step1": "[1/2] DeepSeek API key",
  "onboard.done": "✓ Setup complete. Let's go.",
  "key.help": "Get a key: https://platform.deepseek.com/api_keys",
  "key.missing.title": "No DeepSeek API key found. Set one up via any of:",
  "key.missing.env": "  • Env var: export DEEPSEEK_API_KEY=sk-...",
  "key.missing.dotenv": "  • Project .env: add a line DEEPSEEK_API_KEY=sk-...",
  "key.missing.tty": "  • Run dao directly in a terminal (no pipe) to be guided through pasting and saving a key",
  "key.envSource": "※ Using the key from env var {0} (overriding the stored profile).",
  "trust.step2": "[2/2] Folder trust",
  "trust.prompt": "⚠ This folder is not yet trusted:\n  {0}\ndao will load and may execute its project config (.dao/settings.json and hooks.json).\nTrust this folder? [y/N] ",
  "trust.trusted": "✓ Folder trusted; loading its project config.",
  "trust.untrusted": "Continuing (untrusted): project-level settings/hooks not loaded. Run `dao trust` later to trust.",
  "trust.nonTty": "⚠ This folder's project config is untrusted (.dao/settings.json and hooks.json not loaded). Run `dao trust` once you've confirmed it's safe, then restart to load.",
  "wizard.paste": "Paste your key: ",
  "wizard.abandoned": "No key entered; aborted.",
  "wizard.validating": "Validating key…",
  "wizard.retry": "✗ {0}. Try again (press Enter to abort).",
  "wizard.storedKeychain": "✓ Validated and saved to the system keychain.",
  "wizard.storedFile": "✓ Validated and saved (file, mode 600).",
  "validate.reason.invalid": "key invalid (auth rejected)",
  "validate.reason.unreachable": "network unreachable; can't reach the API",
  "validate.reason.http": "the API returned an error",
  "validate.reason.fail": "validation failed",
  "welcome.model": "Model ",
  "welcome.ctx": "1M context",
  "welcome.dir": "Dir ",
  "welcome.quickstart": "Quick start",
  "welcome.hint": "Type a message to begin · /help for commands · @ to reference files · Esc to interrupt",
  "welcome.try": "Try · ",
};

export const enTips: string[] = [
  "Type / for all commands · @ to reference files · Shift+Tab to switch permission mode · Esc to interrupt",
  "New project? Run /init — it scans the repo into DAO.md, auto-loaded every session afterward",
  "/skills lists available skills; dao skill add <git> installs a set (e.g. superpowers), tool names auto-adapted",
  "dao plugin add <git> installs a plugin — one plugin can bundle several skills",
  "/context shows context usage; it auto-compacts near the limit, or run /compact manually",
  "/rewind rewinds the conversation; /rewind <n> code rolls back files too (shadow git, your real commits untouched)",
  "/restore reverts workspace files to the last checkpoint; it auto-saves before reverting, so you can recover",
  "/resume lists past sessions and loads their context; /branch saves a branch, /rename names a session",
  "/diff shows uncommitted changes; /review has dao review them (gh PRs too); /security-review checks security",
  "Big tasks: /goal <goal> drives autonomously; when large enough it orchestrates subagents in research→synthesize→implement→verify phases",
  "/batch splits a big change across parallel worktree subagents, each on its own branch",
  "/loop 5m <thing> runs periodically in-session; dao schedule runs it on local cron",
  "Shift+Tab cycles permission modes: default → auto (AI-judged) → plan; for accept-edits use /mode acceptEdits",
  "/bypass skips approvals (careful); deny rules and sensitive paths (.ssh/.git/credentials…) still block you",
  "dao remembers automatically; /remember <thing> notes one manually, /memory shows the user/knowledge/project layers",
  "/effort tunes thinking depth (low/medium/high/max); /cost shows usage and cache hit rate",
  "Large pasted text auto-collapses to a placeholder; /copy copies the last answer to the clipboard",
  "Stuck? /debug reads the session log to diagnose; /doctor checks your env (API key / PATH / binary signature)",
  "Have dao dispatch an explore subagent to dig, or a verify subagent to adversarially test (it actually runs things to find counterexamples)",
  "/simplify cleans up code you just changed (quality only, no bug hunting); /skillify distills this session into a skill",
  "/tasks shows background subagents; /mcp shows connected MCP servers; /agents shows available subagent types",
  "Keep typing while it runs — Enter queues; Esc interrupts gracefully anytime (model stream and shell stop together)",
];
```

- [ ] **Step 5: 写 `src/i18n/i18n.ts`**

```ts
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { zh, zhTips } from "./messages/zh.js";
import { en, enTips } from "./messages/en.js";

export type Lang = "zh" | "en";

const DICTS: Record<Lang, Record<string, string>> = { zh, en };
const TIPS: Record<Lang, string[]> = { zh: zhTips, en: enTips };

// 归一化一个显式语言值(DAO_LANG / settings.lang):zh*/zh-CN → zh;en → en;其余 → undefined(非法,忽略)。
function normExplicit(v: string | undefined): Lang | undefined {
  if (!v) return undefined;
  const s = v.toLowerCase();
  if (s.startsWith("zh")) return "zh";
  if (s.startsWith("en")) return "en";
  return undefined;
}

// 优先级:DAO_LANG > settingsLang > 系统 locale(LC_ALL||LC_MESSAGES||LANG)> 默认 en。
export function resolveLang(env: Record<string, string | undefined>, settingsLang?: string): Lang {
  return (
    normExplicit(env.DAO_LANG) ??
    normExplicit(settingsLang) ??
    (((env.LC_ALL || env.LC_MESSAGES || env.LANG || "").toLowerCase().startsWith("zh")) ? "zh" : "en")
  );
}

let current: Lang = "en";
export function setLang(l: Lang): void { current = l; }
export function getLang(): Lang { return current; }

// 查当前语言字典;缺 key → 返回 key 本身;{0}{1}… 位置插值。
export function t(key: string, ...args: (string | number)[]): string {
  const raw = DICTS[current][key] ?? key;
  return raw.replace(/\{(\d+)\}/g, (m, i) => (args[Number(i)] !== undefined ? String(args[Number(i)]) : m));
}

export function tips(): string[] { return TIPS[current]; }

// 读 ~/.dao/settings.json 顶层 lang;缺失/损坏/无字段 → undefined(容错,绝不抛)。
export async function readUserLang(): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(os.homedir(), ".dao", "settings.json"), "utf8");
    const v = (JSON.parse(raw) as { lang?: unknown }).lang;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 6: 跑测试确认通过 + 类型检查**

Run: `npm test -- src/i18n/i18n.test.ts`
Expected: PASS（全部用例）
Run: `npm run typecheck`
Expected: 无类型错误。

- [ ] **Step 7: 提交**

```bash
git add src/i18n
git commit -m "feat(i18n): 新增 i18n 核心模块与 zh/en 关键路径字典"
```

---

### Task 2: 接线 index.ts(启动定语言 + onboarding/信任/缺 key 文案)

**Files:**
- Modify: `src/index.ts`(KEY_HELP:122、main 早期 setLang、267、289-297、307、317-330)

**Interfaces:**
- Consumes: Task 1 的 `resolveLang`/`setLang`/`t`/`readUserLang`

- [ ] **Step 1: 导入 + 启动定语言**

`src/index.ts` 顶部加导入:
```ts
import { resolveLang, setLang, t, readUserLang } from "./i18n/i18n.js";
```
在 `main()` 内、**任何 onboarding 输出之前**(凭证解析那段之前,约 line 255 `// ---- 解析当前生效凭证` 上方)插入:
```ts
  setLang(resolveLang(process.env, await readUserLang()));
```

- [ ] **Step 2: 替换 KEY_HELP 与 onboarding/缺 key/信任 文案**

`src/index.ts:122-123` 改为函数式(KEY_HELP 多处用,统一走 t):删除常量 `KEY_HELP`,把两处引用改为 `t("key.help")`。
- line 267:
```ts
      write(`\n${t("onboard.welcome")}\n\n${t("onboard.step1")}\n${t("key.help")}\n`);
```
- line 290-297(非交互缺 key):
```ts
      console.error(
        [
          t("key.missing.title"),
          t("key.missing.env"),
          t("key.missing.dotenv"),
          t("key.missing.tty"),
          t("key.help"),
        ].join("\n"),
      );
```
- line 307(env 来源):
```ts
  if (keySource.startsWith("env:")) write(`${t("key.envSource", keySource.slice(4))}\n`);
```
- line 317(信任问答):
```ts
      const a = (await ask(
        `${firstRun ? `\n${t("trust.step2")}\n` : "\n"}${t("trust.prompt", workspaceRoot)}`,
      )).trim().toLowerCase();
```
- line 322 / 324 / 327 / 330:
```ts
        write(`${t("trust.trusted")}\n`);
        // ...
        write(`${t("trust.untrusted")}\n`);
      // ...
      process.stderr.write(`${t("trust.nonTty")}\n`);
  // ...
  if (firstRun) write(`\n${t("onboard.done")}\n`);
```

- [ ] **Step 3: 跑全套 + 类型检查**

Run: `npm test`
Expected: 全绿（无既有测试断这些 index 文案 —— 见计划自检；若出现失败,定位并改为 `setLang("zh")` 后断言）。
Run: `npm run typecheck`
Expected: 无类型错误（确认删 KEY_HELP 后无悬空引用）。

- [ ] **Step 4: 提交**

```bash
git add src/index.ts
git commit -m "feat(i18n): index.ts onboarding/信任/缺key 文案走 t() + 启动定语言"
```

---

### Task 3: 接线 auth_wizard.ts + 修受影响测试

**Files:**
- Modify: `src/config/auth_wizard.ts`(REASON_TEXT:5-9、29、31、34、37、41)
- Modify: `src/config/auth_wizard.test.ts`(line 67 的中文断言)

**Interfaces:**
- Consumes: Task 1 的 `t`/`setLang`

- [ ] **Step 1: 替换 wizard 文案**

`src/config/auth_wizard.ts` 顶部加 `import { t } from "../i18n/i18n.js";`,删除 `REASON_TEXT` 常量,改各处:
```ts
    const key = (await ask(t("wizard.paste"))).trim();
    if (!key) {
      write(`${t("wizard.abandoned")}\n`);
      return null;
    }
    write(`${t("wizard.validating")}\n`);
    const v = await validate({ baseUrl: meta.baseUrl, key });
    if (!v.ok) {
      const reason = v.reason === "invalid" ? t("validate.reason.invalid")
        : v.reason === "unreachable" ? t("validate.reason.unreachable")
        : v.reason === "http" ? t("validate.reason.http")
        : t("validate.reason.fail");
      write(`${t("wizard.retry", reason)}\n`);
      continue;
    }
    const { cfg, stored } = await persistKey(deps.cfg, deps.name, meta, key, kc, { preferKeychain });
    write(stored === "keychain" ? `${t("wizard.storedKeychain")}\n` : `${t("wizard.storedFile")}\n`);
```

- [ ] **Step 2: 修 auth_wizard.test.ts:67**

该用例脚本化一个 invalid 校验并断言 reason 文案。默认语言 en 下输出英文,旧断言 `toContain("无效")` 会断。在该测试文件顶部加 `import { setLang } from "../i18n/i18n.js";`,并在断言前固定中文:
```ts
    setLang("zh");
    // ...触发 invalid 校验后...
    expect(h.out.join("")).toContain("无效");
```
(放在该 `it` 内、调用 wizard 之前。)

- [ ] **Step 3: 跑测试确认通过**

Run: `npm test -- src/config/auth_wizard.test.ts`
Expected: PASS。
Run: `npm test`
Expected: 全套全绿。

- [ ] **Step 4: 提交**

```bash
git add src/config/auth_wizard.ts src/config/auth_wizard.test.ts
git commit -m "feat(i18n): auth_wizard 文案与校验报错走 t();修受影响测试"
```

---

### Task 4: 接线 Welcome.tsx 页脚 + tips.ts

**Files:**
- Modify: `src/tui/Welcome.tsx`(页脚 104-130;**不动** maxim/wordmark/taiji)
- Modify: `src/tui/tips.ts`(`randomTip` 改从 `tips()` 取)

**Interfaces:**
- Consumes: Task 1 的 `t`/`tips`

- [ ] **Step 1: tips.ts 改走 i18n**

`src/tui/tips.ts` 改为(保留 `randomTip` 导出名,内部从当前语言 tips 取;`TIPS` 常量删除):
```ts
import { tips } from "../i18n/i18n.js";

export function randomTip(): string {
  const list = tips();
  return list[Math.floor(Math.random() * list.length)] ?? list[0]!;
}
```

- [ ] **Step 2: Welcome.tsx 页脚走 t()**

`src/tui/Welcome.tsx` 顶部加 `import { t } from "../i18n/i18n.js";`。改页脚(约 104-130):
```tsx
          <Text>
            <Text color={c("dim")}>{t("welcome.model")}</Text>
            <Text color={c("ink")}>
              {info.model} · {info.thinking} · {t("welcome.ctx")}
            </Text>
          </Text>
          <Text>
            <Text color={c("dim")}>{t("welcome.dir")}</Text>
            <Text color={c("ink")}>{shortenPath(info.cwd)}</Text>
            {info.branch ? <Text color={c("jade")}>{"  ⎇ "}{info.branch}</Text> : null}
          </Text>
```
```tsx
          <Text color={c("dim")}>{t("welcome.quickstart")}</Text>
          <Text color={c("dim")}>{t("welcome.hint")}</Text>
          <Text color={c("jade")}>{t("welcome.try")}{tip}</Text>
```
**不动** `sealLine`(maxim/落款)与 taiji/wordmark。

- [ ] **Step 3: 跑测试确认通过**

Run: `npm test -- src/tui/`
Expected: PASS（App.test.tsx 断的是 `/account` 选择器"粘贴新账户"、编号等,均不在改动范围;若 Welcome 相关快照/断言因默认 en 变化,改为该测试内 `setLang("zh")` 后断言或更新断言为对应英文)。
Run: `npm test`
Expected: 全套全绿。

- [ ] **Step 4: 提交**

```bash
git add src/tui/Welcome.tsx src/tui/tips.ts
git commit -m "feat(i18n): 欢迎屏页脚与 tips 走 i18n(名句/太极不动)"
```

---

### Task 5: 全量回归 + 构建 + 双语自查

**Files:** 无新增。

- [ ] **Step 1: 全量单测**

Run: `npm test`
Expected: 全绿。

- [ ] **Step 2: 类型检查 + 构建**

Run: `npm run typecheck && npm run build`
Expected: 均成功。

- [ ] **Step 3: 双语启动自查(手动,可选)**

```bash
DAO_LANG=en npm run dev   # 预期:欢迎/页脚/提示为英文,名句仍中文
DAO_LANG=zh npm run dev   # 预期:全中文
```
Expected: 英文路径无残留中文功能文案;名句/太极保持中文。

- [ ] **Step 4:(无代码改动则无 commit)**

---

## Self-Review

- **Spec 覆盖**:§2.1 i18n.ts→Task1;§2.2 readUserLang→Task1;§2.3 启动接线→Task2;§2.4 替换清单 index→Task2 / auth_wizard→Task3 / Welcome+tips→Task4;§5 测试→Task1 内联 + Task3 修 auth_wizard.test + Task5 全量。§3 不做项(无 /lang、不碰系统提示、名句不动)无对应任务(正确)。
- **占位符扫描**:无 TBD/TODO;zh 值逐字抄源、en 值全部给出;每个 code step 含完整代码与命令、预期输出。
- **类型一致**:`Lang`/`resolveLang`/`setLang`/`getLang`/`t`/`tips`/`readUserLang` 在 Task1 定义,Task2-4 一致消费;字典 key(`onboard.*`/`trust.*`/`wizard.*`/`validate.reason.*`/`welcome.*`/`key.*`)在 zh/en 两表与各替换点完全对应。
- **回归面**:经全库 grep,替换范围内唯一断中文串的旧测试是 `auth_wizard.test.ts:67`(Task3 Step2 修);`App.test.tsx` 的"粘贴新账户"等不在范围。
