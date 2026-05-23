# DAO CODE P1:颜色分层 + 欢迎屏 + 道德经名句 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `dao` 启动时显示一个水墨极简·太极风格、随机道德经名句的欢迎屏,颜色按终端能力(truecolor/256/16/none)自动分层降级,非 TTY/管道走纯文本;完成 codeds → DAO CODE 改名(命令 `dao`)。

**Architecture:** P1 **不引入 Ink**——欢迎屏是一次性静态横幅,用主题化 ANSI 字符串 `process.stdout.write` 一次输出即可,无需 reconciler,也避免与现有 readline 抢 stdin(Ink 推迟到 P2)。新增 `tui/capabilities.ts`(能力探测)、`tui/theme.ts`(语义色→分档 ANSI,渐变手写 RGB 插值)、`tui/maxim.ts` + `data/laozi-maxims.ts`(名句库)、`tui/banner.ts`(组装横幅),在 `index.ts` 启动处接线。**P1 零新运行时依赖。**

**Tech Stack:** TypeScript (ESM, `moduleResolution: Bundler`)、tsx、vitest。复用现有 `src/tui/width.ts`(CJK 宽度)。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/tui/capabilities.ts` | 纯函数:`(env, isTTY, columns?) → {tier, isTTY, columns}` 探测颜色档位 |
| `src/tui/capabilities.test.ts` | 各 env/TTY 组合 → 档位 |
| `src/tui/theme.ts` | 语义色表 + `paint()`/`gradientBlock()`,按档输出 ANSI 或纯文本 |
| `src/tui/theme.test.ts` | 各档取色 / none 档无 ANSI / 渐变仅 truecolor |
| `src/data/laozi-maxims.ts` | 精选道德经名句常量数组(真实内容) |
| `src/tui/maxim.ts` | `randomMaxim(rng?)` 从库随机取 |
| `src/tui/maxim.test.ts` | 注入 rng,断言取自库 |
| `src/tui/banner.ts` | `buildWelcome(info, caps, rng?) → string` 组装太极/词标/印/名句/信息/分隔/提示 |
| `src/tui/banner.test.ts` | 含 DAO CODE/名句/模型;none 档无 ANSI;truecolor 含真彩转义 |
| `src/version.ts` | `export const VERSION` |
| `scripts/preview-welcome.ts` | 独立预览横幅(支持 `--tier` 强制档位),供真终端目视调优 |
| `src/index.ts` | 启动处接线 + 改名 codeds→DAO CODE |
| `package.json` | name→`dao-code`、`bin.dao`、`preview:welcome` 脚本 |

> **道德经全文下载**:P1 运行时只需精选名句库(本任务内含真实内容,确定性、零联网)。81 章全文归档(`data/laozi.json`)作为后续增强,不在 P1 关键路径。

---

### Task 1: 颜色能力探测 `capabilities.ts`

**Files:**
- Create: `src/tui/capabilities.ts`
- Test: `src/tui/capabilities.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/tui/capabilities.test.ts
import { describe, it, expect } from "vitest";
import { detectCapabilities } from "./capabilities.js";

describe("detectCapabilities", () => {
  it("非 TTY → none", () => {
    const c = detectCapabilities({}, false);
    expect(c.tier).toBe("none");
    expect(c.isTTY).toBe(false);
  });
  it("NO_COLOR 即使 TTY 也 → none", () => {
    expect(detectCapabilities({ NO_COLOR: "1", COLORTERM: "truecolor" }, true).tier).toBe("none");
  });
  it("COLORTERM=truecolor → truecolor", () => {
    expect(detectCapabilities({ COLORTERM: "truecolor" }, true).tier).toBe("truecolor");
  });
  it("COLORTERM=24bit → truecolor", () => {
    expect(detectCapabilities({ COLORTERM: "24bit" }, true).tier).toBe("truecolor");
  });
  it("TERM 含 256color → ansi256", () => {
    expect(detectCapabilities({ TERM: "xterm-256color" }, true).tier).toBe("ansi256");
  });
  it("普通 TTY 无线索 → ansi16", () => {
    expect(detectCapabilities({ TERM: "xterm" }, true).tier).toBe("ansi16");
  });
  it("FORCE_COLOR=3 → truecolor(便于强制)", () => {
    expect(detectCapabilities({ FORCE_COLOR: "3" }, true).tier).toBe("truecolor");
  });
  it("columns 默认 80,可由 COLUMNS 覆盖", () => {
    expect(detectCapabilities({}, true).columns).toBe(80);
    expect(detectCapabilities({ COLUMNS: "120" }, true).columns).toBe(120);
    expect(detectCapabilities({}, true, 100).columns).toBe(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tui/capabilities.test.ts`
Expected: FAIL（`detectCapabilities` 不存在 / 模块未找到）

- [ ] **Step 3: Write minimal implementation**

```ts
// src/tui/capabilities.ts
export type ColorTier = "truecolor" | "ansi256" | "ansi16" | "none";

export interface Capabilities {
  tier: ColorTier;
  isTTY: boolean;
  columns: number;
}

// 探测终端颜色能力。优先级:非TTY/NO_COLOR → none;FORCE_COLOR/COLORTERM → truecolor;
// TERM 含 256color → ansi256;否则 TTY → ansi16。columns:显式参数 > COLUMNS > 80。
export function detectCapabilities(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  isTTY: boolean,
  columns?: number,
): Capabilities {
  const cols = columns ?? (env.COLUMNS ? parseInt(env.COLUMNS, 10) : 80) || 80;
  if (!isTTY || env.NO_COLOR) return { tier: "none", isTTY, columns: cols };

  const force = env.FORCE_COLOR;
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  const term = (env.TERM ?? "").toLowerCase();

  let tier: ColorTier;
  if (force === "3" || /truecolor|24bit/.test(colorterm)) tier = "truecolor";
  else if (force === "2" || term.includes("256color")) tier = "ansi256";
  else tier = "ansi16";

  return { tier, isTTY, columns: cols };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tui/capabilities.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: Commit**

```bash
git add src/tui/capabilities.ts src/tui/capabilities.test.ts
git commit -m "feat(tui): 颜色能力探测(truecolor/256/16/none 分档)"
```

---

### Task 2: 主题与取色 `theme.ts`

**Files:**
- Create: `src/tui/theme.ts`
- Test: `src/tui/theme.test.ts`

语义色:`ink`(默认前景)、`jade`(青玉,主强调)、`vermilion`(朱砂,印章)、`dim`(次要)、`gold`(点缀)。每语义给 truecolor RGB、ansi256 索引、ansi16 SGR 码。`paint` 按档包裹;`gradientBlock` 对多行做 jade→ink 真彩渐变(非 truecolor 退化为整体 `jade`)。

- [ ] **Step 1: Write the failing test**

```ts
// src/tui/theme.test.ts
import { describe, it, expect } from "vitest";
import { paint, gradientBlock } from "./theme.js";
import type { Capabilities } from "./capabilities.js";

const caps = (tier: Capabilities["tier"]): Capabilities => ({ tier, isTTY: true, columns: 80 });

describe("paint", () => {
  it("none 档:原样返回,无 ANSI", () => {
    const out = paint("道", "jade", caps("none"));
    expect(out).toBe("道");
    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(out)).toBe(false);
  });
  it("truecolor 档:含 38;2;r;g;b 前景", () => {
    const out = paint("道", "jade", caps("truecolor"));
    expect(out).toContain("\x1b[38;2;");
    expect(out).toContain("道");
    expect(out.endsWith("\x1b[39m")).toBe(true);
  });
  it("ansi256 档:含 38;5;N", () => {
    expect(paint("道", "jade", caps("ansi256"))).toContain("\x1b[38;5;");
  });
  it("ansi16 档:含基础 SGR(30-37 或 90-97)", () => {
    const out = paint("道", "vermilion", caps("ansi16"));
    expect(/\x1b\[(3[0-7]|9[0-7])m/.test(out)).toBe(true);
  });
});

describe("gradientBlock", () => {
  it("truecolor:每行被真彩转义包裹", () => {
    const lines = gradientBlock(["AAAA", "BBBB"], "jade", "ink", caps("truecolor"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("\x1b[38;2;");
  });
  it("none:原样无 ANSI", () => {
    const lines = gradientBlock(["AAAA"], "jade", "ink", caps("none"));
    expect(lines[0]).toBe("AAAA");
  });
  it("非 truecolor(ansi256):退化为单色 jade,不做逐字渐变", () => {
    const lines = gradientBlock(["AAAA"], "jade", "ink", caps("ansi256"));
    expect(lines[0]).toContain("\x1b[38;5;");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tui/theme.test.ts`
Expected: FAIL（`paint`/`gradientBlock` 未定义）

- [ ] **Step 3: Write minimal implementation**

```ts
// src/tui/theme.ts
import type { Capabilities } from "./capabilities.js";

export type Semantic = "ink" | "jade" | "vermilion" | "dim" | "gold";

type RGB = [number, number, number];
interface ColorSpec { rgb: RGB; ansi256: number; ansi16: string } // ansi16:SGR 数字串如 "36"

// 一套精调默认主题(墨黑底假设):青玉强调 + 朱砂印 + 暖金点缀。
const PALETTE: Record<Semantic, ColorSpec> = {
  ink:       { rgb: [220, 223, 228], ansi256: 252, ansi16: "37" },
  jade:      { rgb: [127, 183, 166], ansi256: 79,  ansi16: "36" },
  vermilion: { rgb: [200, 68, 60],   ansi256: 167, ansi16: "31" },
  dim:       { rgb: [128, 132, 140], ansi256: 245, ansi16: "90" },
  gold:      { rgb: [201, 168, 106], ansi256: 179, ansi16: "33" },
};

const FG_RESET = "\x1b[39m";

function fg(rgb: RGB): string {
  return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

// 用语义色包裹一段文本(单行)。none 档返回原文。
export function paint(text: string, sem: Semantic, caps: Capabilities): string {
  const c = PALETTE[sem];
  switch (caps.tier) {
    case "none": return text;
    case "truecolor": return `${fg(c.rgb)}${text}${FG_RESET}`;
    case "ansi256": return `\x1b[38;5;${c.ansi256}m${text}${FG_RESET}`;
    case "ansi16": return `\x1b[${c.ansi16}m${text}${FG_RESET}`;
  }
}

// 线性插值两 RGB。
function lerp(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

// 对多行块做 from→to 的横向真彩渐变(按列位置插值,逐行一致,呈竖直统一的横向渐变)。
// 非 truecolor 退化:整体用 from 语义单色(paint 每行);none 原样。
export function gradientBlock(lines: string[], from: Semantic, to: Semantic, caps: Capabilities): string[] {
  if (caps.tier === "none") return [...lines];
  if (caps.tier !== "truecolor") return lines.map((l) => paint(l, from, caps));
  const a = PALETTE[from].rgb;
  const b = PALETTE[to].rgb;
  const maxLen = Math.max(1, ...lines.map((l) => [...l].length));
  return lines.map((line) => {
    const chars = [...line];
    let out = "";
    chars.forEach((ch, i) => {
      const t = chars.length > 1 ? i / (maxLen - 1 || 1) : 0;
      out += `${fg(lerp(a, b, Math.min(1, t)))}${ch}`;
    });
    return out + FG_RESET;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tui/theme.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/theme.ts src/tui/theme.test.ts
git commit -m "feat(tui): 语义主题 + 分档取色 + 手写真彩渐变"
```

---

### Task 3: 道德经名句库 + 随机取

**Files:**
- Create: `src/data/laozi-maxims.ts`
- Create: `src/tui/maxim.ts`
- Test: `src/tui/maxim.test.ts`

- [ ] **Step 1: 写名句库(真实内容)**

```ts
// src/data/laozi-maxims.ts
// 精选《道德经》名句(公有领域,老子)。chapter 为章次。
export interface Maxim { text: string; chapter: number }

export const MAXIMS: Maxim[] = [
  { text: "道可道，非常道；名可名，非常名。", chapter: 1 },
  { text: "上善若水，水善利万物而不争。", chapter: 8 },
  { text: "知人者智，自知者明。", chapter: 33 },
  { text: "胜人者有力，自胜者强。", chapter: 33 },
  { text: "千里之行，始于足下。", chapter: 64 },
  { text: "合抱之木，生于毫末。", chapter: 64 },
  { text: "大巧若拙，大辩若讷。", chapter: 45 },
  { text: "大方无隅，大器晚成，大音希声，大象无形。", chapter: 41 },
  { text: "知足不辱，知止不殆。", chapter: 44 },
  { text: "祸兮福之所倚，福兮祸之所伏。", chapter: 58 },
  { text: "天下难事，必作于易；天下大事，必作于细。", chapter: 63 },
  { text: "为学日益，为道日损。", chapter: 48 },
  { text: "无为而无不为。", chapter: 48 },
  { text: "信言不美，美言不信。", chapter: 81 },
  { text: "知者不言，言者不知。", chapter: 56 },
  { text: "道生一，一生二，二生三，三生万物。", chapter: 42 },
  { text: "人法地，地法天，天法道，道法自然。", chapter: 25 },
  { text: "治大国，若烹小鲜。", chapter: 60 },
  { text: "善行无辙迹，善言无瑕谪。", chapter: 27 },
  { text: "见素抱朴，少私寡欲。", chapter: 19 },
  { text: "致虚极，守静笃。", chapter: 16 },
  { text: "曲则全，枉则直。", chapter: 22 },
  { text: "夫唯不争，故天下莫能与之争。", chapter: 22 },
  { text: "知其雄，守其雌。", chapter: 28 },
  { text: "大成若缺，其用不弊。", chapter: 45 },
  { text: "重为轻根，静为躁君。", chapter: 26 },
  { text: "江海所以能为百谷王者，以其善下之。", chapter: 66 },
  { text: "天之道，利而不害；圣人之道，为而不争。", chapter: 81 },
  { text: "祸莫大于不知足，咎莫大于欲得。", chapter: 46 },
  { text: "图难于其易，为大于其细。", chapter: 63 },
];
```

- [ ] **Step 2: Write the failing test**

```ts
// src/tui/maxim.test.ts
import { describe, it, expect } from "vitest";
import { randomMaxim } from "./maxim.js";
import { MAXIMS } from "../data/laozi-maxims.js";

describe("randomMaxim", () => {
  it("注入 rng=0 取第一条", () => {
    expect(randomMaxim(() => 0)).toEqual(MAXIMS[0]);
  });
  it("注入 rng≈1 取最后一条", () => {
    expect(randomMaxim(() => 0.999999)).toEqual(MAXIMS[MAXIMS.length - 1]);
  });
  it("默认无参也返回库中一条", () => {
    expect(MAXIMS).toContainEqual(randomMaxim());
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/tui/maxim.test.ts`
Expected: FAIL（`randomMaxim` 未定义）

- [ ] **Step 4: Write minimal implementation**

```ts
// src/tui/maxim.ts
import { MAXIMS, type Maxim } from "../data/laozi-maxims.js";

// 从精选名句库随机取一条。rng 可注入便于测试(默认 Math.random)。
export function randomMaxim(rng: () => number = Math.random): Maxim {
  const i = Math.min(MAXIMS.length - 1, Math.floor(rng() * MAXIMS.length));
  return MAXIMS[i]!;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/tui/maxim.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/data/laozi-maxims.ts src/tui/maxim.ts src/tui/maxim.test.ts
git commit -m "feat(tui): 道德经精选名句库 + 随机取"
```

---

### Task 4: 版本常量

**Files:**
- Create: `src/version.ts`

- [ ] **Step 1: 写常量(无需测试,纯常量)**

```ts
// src/version.ts
// DAO CODE 版本(改名里程碑起步版)。
export const VERSION = "0.1.0";
```

- [ ] **Step 2: Commit**

```bash
git add src/version.ts
git commit -m "chore: add VERSION constant"
```

---

### Task 5: 欢迎横幅 `banner.ts`

**Files:**
- Create: `src/tui/banner.ts`
- Test: `src/tui/banner.test.ts`

组装:太极(灰阶)+ DAO CODE 词标(jade→ink 渐变)+ 朱砂"道"印 + 随机名句(dim)+ 信息行 + 水墨分隔 + 提示行。整体按 `caps.columns` 居中。复用 `width.ts` 的 `displayWidth`。

> 太极/词标 ASCII 为初始稿,后续用 `preview:welcome` 在真终端目视微调(Task 7)。banner 测试只断言文本要素与颜色档行为,不锁死美术字形。

- [ ] **Step 1: Write the failing test**

```ts
// src/tui/banner.test.ts
import { describe, it, expect } from "vitest";
import { buildWelcome, type WelcomeInfo } from "./banner.js";
import type { Capabilities } from "./capabilities.js";

const info: WelcomeInfo = {
  model: "deepseek-v4-pro",
  thinking: "max",
  mode: "normal",
  memories: 4,
  cwd: "/Users/x/code/codeds",
  version: "0.1.0",
};
const caps = (tier: Capabilities["tier"]): Capabilities => ({ tier, isTTY: true, columns: 80 });
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("buildWelcome", () => {
  it("含品牌、模型、模式、版本、提示", () => {
    const out = strip(buildWelcome(info, caps("truecolor"), () => 0));
    expect(out).toContain("DAO CODE");
    expect(out).toContain("道");
    expect(out).toContain("deepseek-v4-pro");
    expect(out).toContain("normal");
    expect(out).toContain("0.1.0");
    expect(out).toContain("/help");
    expect(out).toContain("Esc");
  });
  it("注入 rng=0:含名句库第一条文本", () => {
    const out = strip(buildWelcome(info, caps("none"), () => 0));
    expect(out).toContain("道可道，非常道");
  });
  it("none 档:整体无 ANSI 转义", () => {
    const out = buildWelcome(info, caps("none"), () => 0);
    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(out)).toBe(false);
  });
  it("truecolor 档:含真彩转义(词标渐变)", () => {
    const out = buildWelcome(info, caps("truecolor"), () => 0);
    expect(out).toContain("\x1b[38;2;");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tui/banner.test.ts`
Expected: FAIL（`buildWelcome` 未定义）

- [ ] **Step 3: Write minimal implementation**

```ts
// src/tui/banner.ts
import type { Capabilities } from "./capabilities.js";
import { paint, gradientBlock } from "./theme.js";
import { randomMaxim } from "./maxim.js";
import { displayWidth } from "./width.js";

export interface WelcomeInfo {
  model: string;
  thinking: string;
  mode: string;
  memories: number;
  cwd: string;
  version: string;
}

// 太极初始美术(半块字符;后续 preview 目视微调)。
const TAIJI = [
  "      ▄▀▀▀▀▀▄",
  "    ▄▀  ▄▄▄  ▀▄",
  "   █   █████   █",
  "   █   ▀▀▀▀▀   █",
  "   █   ▄▄▄▄▄   █",
  "    ▀▄  ▀▀▀  ▄▀",
  "      ▀▄▄▄▄▄▀",
];

// DAO CODE 词标(ANSI Shadow 风格,初始稿)。
const WORDMARK = [
  "██████╗  █████╗  ██████╗    ██████╗ ██████╗ ██████╗ ███████╗",
  "██╔══██╗██╔══██╗██╔═══██╗  ██╔════╝██╔═══██╗██╔══██╗██╔════╝",
  "██║  ██║███████║██║   ██║  ██║     ██║   ██║██║  ██║█████╗  ",
  "██║  ██║██╔══██║██║   ██║  ██║     ██║   ██║██║  ██║██╔══╝  ",
  "██████╔╝██║  ██║╚██████╔╝  ╚██████╗╚██████╔╝██████╔╝███████╗",
  "╚═════╝ ╚═╝  ╚═╝ ╚═════╝    ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝",
];

// 居中一行:按"可见宽度"(去 ANSI,用 displayWidth 处理 CJK)算缩进。
function centerColored(line: string, visibleLen: number, columns: number): string {
  const pad = Math.max(0, Math.floor((columns - visibleLen) / 2));
  return " ".repeat(pad) + line;
}

export function buildWelcome(info: WelcomeInfo, caps: Capabilities, rng?: () => number): string {
  const cols = caps.columns;
  const out: string[] = [];
  const blank = () => out.push("");

  blank();
  // 太极(灰阶 dim):按原始行宽(去 ANSI)居中
  TAIJI.forEach((row) => out.push(centerColored(paint(row, "dim", caps), displayWidth(row), cols)));

  blank();
  // 词标(jade→ink 渐变),按原始行宽居中
  const wm = gradientBlock(WORDMARK, "jade", "ink", caps);
  WORDMARK.forEach((raw, i) => out.push(centerColored(wm[i]!, displayWidth(raw), cols)));

  blank();
  // 朱砂"道"落款 + 副标题
  const seal = paint("【道】", "vermilion", caps);
  const sub = paint("DeepSeek V4 编码之道", "dim", caps);
  const sealLine = `${seal}  ${sub}`;
  out.push(centerColored(sealLine, displayWidth("【道】  DeepSeek V4 编码之道"), cols));

  blank();
  // 随机名句
  const m = randomMaxim(rng);
  const quoteRaw = `「${m.text}」`;
  out.push(centerColored(paint(quoteRaw, "jade", caps), displayWidth(quoteRaw), cols));
  const byRaw = `— 老子 · 第${m.chapter}章`;
  out.push(centerColored(paint(byRaw, "dim", caps), displayWidth(byRaw), cols));

  blank();
  // 信息行(左对齐到一个统一缩进)
  const indent = "   ";
  const line = (label: string, value: string) =>
    `${indent}${paint(label, "dim", caps)} ${paint(value, "ink", caps)}`;
  out.push(line("模型", `${info.model} · ${info.thinking}`));
  out.push(line("模式", `${info.mode}      记忆 ${info.memories} 条`));
  out.push(line("目录", `${info.cwd}      v${info.version}`));

  blank();
  // 水墨分隔
  const ruleRaw = "╌".repeat(Math.min(48, Math.max(20, cols - 6)));
  out.push(centerColored(paint(ruleRaw, "dim", caps), displayWidth(ruleRaw), cols));

  // 提示行
  const tipRaw = "输入消息开始 · /help 命令 · @ 引用文件 · Esc 打断";
  out.push(centerColored(paint(tipRaw, "dim", caps), displayWidth(tipRaw), cols));
  blank();

  return out.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tui/banner.test.ts`
Expected: PASS

- [ ] **Step 5: typecheck**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add src/tui/banner.ts src/tui/banner.test.ts
git commit -m "feat(tui): 欢迎横幅(太极+DAO CODE渐变词标+朱砂印+道德经名句)"
```

---

### Task 6: 预览脚本 `preview-welcome.ts`

**Files:**
- Create: `scripts/preview-welcome.ts`
- Modify: `package.json`(加 `preview:welcome` 脚本)

- [ ] **Step 1: 写预览脚本**

```ts
// scripts/preview-welcome.ts
// 独立预览欢迎横幅,供真终端目视调优。
//   npm run preview:welcome             # 用真实终端能力
//   npm run preview:welcome -- --tier truecolor   # 强制档位(truecolor/ansi256/ansi16/none)
import { detectCapabilities, type ColorTier } from "../src/tui/capabilities.js";
import { buildWelcome } from "../src/tui/banner.js";

const arg = process.argv.indexOf("--tier");
const forced = arg >= 0 ? (process.argv[arg + 1] as ColorTier) : undefined;

const real = detectCapabilities(process.env, !!process.stdout.isTTY, process.stdout.columns);
const caps = forced ? { ...real, tier: forced } : real;

process.stdout.write(
  buildWelcome(
    {
      model: "deepseek-v4-pro",
      thinking: "max",
      mode: "normal",
      memories: 4,
      cwd: process.cwd(),
      version: "0.1.0",
    },
    caps,
  ) + "\n",
);
```

- [ ] **Step 2: 加 npm 脚本**

修改 `package.json` 的 `scripts`,在 `"dev"` 后加一行:

```json
    "preview:welcome": "tsx scripts/preview-welcome.ts",
```

- [ ] **Step 3: 跑预览(目视验收)**

Run: `npm run preview:welcome -- --tier truecolor`
Expected: 终端打印居中的太极 + DAO CODE 渐变词标 + 朱砂【道】+ 一条道德经名句 + 信息行。
再跑 `npm run preview:welcome -- --tier none`,Expected: 纯文本无颜色、布局不乱。

- [ ] **Step 4: 美观微调(与用户闭环)**

> 这一步是与用户的视觉迭代:在真终端跑/截图,按反馈调 `TAIJI`/`WORDMARK`/间距/调色板,直到用户认可。每次调整后重跑 Step 3,banner 测试仍须 PASS(`npx vitest run src/tui/banner.test.ts`)。

- [ ] **Step 5: Commit**

```bash
git add scripts/preview-welcome.ts package.json
git commit -m "chore(tui): 欢迎屏预览脚本(支持 --tier 强制档位)"
```

---

### Task 7: 接线到启动 + 改名 DAO CODE(命令 `dao`)

**Files:**
- Modify: `src/index.ts`（启动横幅 + 改名）
- Modify: `package.json`（name / bin）

- [ ] **Step 1: index.ts 接入横幅**

在 `src/index.ts` 顶部 import 区加:

```ts
import { detectCapabilities } from "./tui/capabilities.js";
import { buildWelcome } from "./tui/banner.js";
import { VERSION } from "./version.js";
```

把交互入口处原来这行(约 237 行):

```ts
    write(`codeds —— 输入消息开始;/help 看命令,/exit 退出。\n`);
```

替换为:

```ts
    const caps = detectCapabilities(process.env, !!process.stdout.isTTY, process.stdout.columns);
    if (caps.isTTY) {
      write(
        buildWelcome(
          {
            model: cfg.model ?? "deepseek-v4-pro",
            thinking: "max",
            mode: session.mode,
            memories: memories.length,
            cwd: workspaceRoot,
            version: VERSION,
          },
          caps,
        ) + "\n",
      );
    } else {
      write(`DAO CODE v${VERSION}\n`);
    }
```

> 说明:`cfg.model` 在 `cfg` 上(可能为 undefined,故兜底);`session.mode`、`memories`、`workspaceRoot` 均为 main() 内既有变量。非 TTY 只打一行,保证 eval/管道输出干净。

- [ ] **Step 2: 改名 codeds → DAO CODE(用户可见文案)**

把 `src/index.ts` 中 `KEY_HELP` 上方/相关文案里出现的产品名 `codeds` 改为 `DAO CODE`。具体:`未检测到 DeepSeek API key` 段落保持;无其它硬编码 "codeds" 展示名则跳过。检查命令:

Run: `grep -n "codeds" src/index.ts`
Expected: 仅剩**路径/目录**相关(如 `.codeds`、`~/.codeds`)——这些**保留不改**;若有产品展示名,改为 `DAO CODE`。

- [ ] **Step 3: package.json 改名与 bin**

修改 `package.json`:
- `"name": "codeds"` → `"name": "dao-code"`
- 在顶层加 `"bin": { "dao": "dist/index.js" }`(发布后命令为 `dao`;开发期用 `npm run dev`)。

- [ ] **Step 4: 全量测试 + typecheck**

Run: `npm test`
Expected: 全绿(含新增 capabilities/theme/maxim/banner 测试)。

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 5: 真实启动目视**

Run: `npm run dev`
Expected: 真终端启动即见欢迎屏(太极/DAO CODE/名句/信息),随后进入 `> ` 提示。Ctrl-C/`/exit` 退出。

- [ ] **Step 6: 非 TTY 回归(确保 eval 不受影响)**

Run: `echo "" | npm run dev 2>&1 | head -3`
Expected: 不渲染横幅(非 TTY),仅 `DAO CODE v0.1.0` 一行 + 后续既有行为;无 ANSI 乱码进管道。

- [ ] **Step 7: Commit**

```bash
git add src/index.ts package.json
git commit -m "feat: 启动欢迎屏接线 + 改名 DAO CODE(命令 dao)"
```

---

## Self-Review(写完自查)

**Spec 覆盖**(对照 spec §10 P1 范围):
- 颜色分层 + 能力探测 → Task 1、2 ✅
- 非 TTY 回退 → Task 7 Step 1/6(非 TTY 只打一行,横幅仅 TTY)✅
- 欢迎屏(方案一·太极)→ Task 5、6 ✅
- 道德经库 → Task 3(精选名句真实内容;全文归档明确推后,非 P1 关键路径)✅
- preview 脚本 → Task 6 ✅
- 改名 DAO CODE / 命令 dao / 保留 .codeds → Task 7 ✅
- Renderer 抽象 / Ink:**按架构说明显式推迟到 P2**(P1 横幅为静态字符串,无需 Ink)——与 spec 的 P1 意图一致,仅把 Ink 依赖下沉到真正需要活动区的 P2。

**Placeholder 扫描**:无 TODO/TBD;美术字形为"初始稿+preview 微调",内容是具体常量,非占位。

**类型一致**:`ColorTier`/`Capabilities`(capabilities.ts)、`Semantic`/`paint`/`gradientBlock`(theme.ts)、`Maxim`/`randomMaxim`(maxim.ts)、`WelcomeInfo`/`buildWelcome`(banner.ts)、`VERSION`(version.ts)在各 Task 间签名一致;`gradientBlock(lines, from, to, caps)` 四参在 banner 调用处一致。

> 已知小瑕疵(执行时留意):banner.ts Step 3 里太极居中先写后"`out.length -=`"回退重写,是为按原始行宽(非含 ANSI)居中;执行时可直接用后半段逻辑、删掉前一段冗余写入(行为不变,更干净)。
