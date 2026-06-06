# codeds M9 — TUI 渲染打磨 实现计划(MVP 收尾)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现设计文档 §11/§14 的 TUI:把助手回复的 **markdown 渲染成终端 ANSI**(标题/粗体/斜体/行内码/代码块/列表/引用/分隔线/表格),表格按 **CJK 宽度**对齐(中文/emoji 占 2 列);reasoning 实时灰显、工具调用用醒目标记。把"展示规则交给渲染器"(§30:prompt 不管展示,渲染器全权)。MVP 最后一块——从"能用"到"好用"。

**Architecture:** 新增 `tui/` 模块:`width.ts`(`displayWidth`/`padEnd`,自实现 East-Asian-Width,中文/CJK/emoji 计 2 列)、`markdown.ts`(`renderMarkdown(md): string`,纯函数,行级解析 → ANSI)、`render.ts`(`renderStream(gen, write): Promise<AssistantMessage>`,取代 loop 里内联的 renderTurn:reasoning 实时灰显、content 缓冲到边界再整体 markdown 渲染、工具调用青色标记)。**零新依赖**(markdown 渲染与 CJK 宽度都自建——契合"理解+极简",且可测)。

**流式权衡(设计取舍):** reasoning 实时灰显;**content 缓冲**(不逐字直出)到"内容块结束(遇 tool_call 或消息结束)"时再 `renderMarkdown` 整体渲染——因为半张 markdown 表格/代码块无法增量渲染。代价是 content 失去逐字打字感,换来 markdown 渲染;增量 markdown 留后期。

**Tech Stack:** 沿用。无新第三方依赖。

参考:设计文档 §11(tui 模块)、§14(MVP:流式渲染+markdown+审批交互)、§30(展示交给渲染器)。M5/M8 的 `agent/loop.ts`(renderTurn 现内联在此)。

**范围与延后**:增量 markdown(边流边渲)不做;审批提示/子代理标记的更花哨展示(boxed/折叠)留 carry-output;行宽自动折行不做;表格内单元格的行内格式(粗体等)不做(保宽度正确)。`string-width` 这类更全的库可后期替换自建 width。Ink 式组件化 UI 不做(与流式文本模型不契合)。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/tui/width.ts` | `displayWidth` / `padEnd`(CJK 宽度) | 新建 |
| `src/tui/markdown.ts` | `renderMarkdown(md): string` | 新建 |
| `src/tui/render.ts` | `renderStream`(流式渲染,取代 renderTurn) | 新建 |
| `src/agent/loop.ts` | 用 `renderStream` 取代内联 `renderTurn` | 改 |

---

## Task 1: CJK 宽度 + markdown 渲染器

**Files:** Create `src/tui/width.ts`, `src/tui/width.test.ts`, `src/tui/markdown.ts`, `src/tui/markdown.test.ts`

### Part A — width

**契约:** `displayWidth(s)` 计显示宽度(CJK/Hangul/Kana/全角/emoji 计 2,其余 1)。`padEnd(s, width)` 用空格右补到目标显示宽度(已够则原样)。

- [ ] **Step 1: 失败测试 `src/tui/width.test.ts`(EXACT)**
```ts
import { describe, it, expect } from "vitest";
import { displayWidth, padEnd } from "./width.js";

describe("displayWidth", () => {
  it("counts ASCII as 1 and CJK as 2", () => {
    expect(displayWidth("ab")).toBe(2);
    expect(displayWidth("张三")).toBe(4);
    expect(displayWidth("a张")).toBe(3);
  });
  it("counts an empty string as 0", () => {
    expect(displayWidth("")).toBe(0);
  });
});

describe("padEnd", () => {
  it("pads CJK-aware to the target display width", () => {
    expect(padEnd("张三", 6)).toBe("张三  "); // 宽 4 → 补 2 空格
    expect(padEnd("ab", 5)).toBe("ab   ");
  });
  it("leaves strings already at/over width unchanged", () => {
    expect(padEnd("张三", 4)).toBe("张三");
    expect(padEnd("abcd", 2)).toBe("abcd");
  });
});
```

- [ ] **Step 2:** `npx vitest run src/tui/width.test.ts` — FAIL。

- [ ] **Step 3: 写 `src/tui/width.ts`(EXACT)**
```ts
// 最小 East-Asian-Width:CJK / Hangul / 假名 / 全角 / 常见 emoji 计 2 列,其余 1 列。
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK 部首…注音…CJK 统一…彝(含汉字、假名等)
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul 音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容形
    (cp >= 0xff00 && cp <= 0xff60) || // 全角 ASCII / 标点
    (cp >= 0xffe0 && cp <= 0xffe6) || // 全角符号
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji & 符号
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展 B+
  );
}

export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    w += isWide(ch.codePointAt(0)!) ? 2 : 1;
  }
  return w;
}

export function padEnd(s: string, width: number): string {
  const w = displayWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}
```

- [ ] **Step 4:** `npx vitest run src/tui/width.test.ts` — 4 PASS。

### Part B — markdown

**契约:** `renderMarkdown(md): string` —— 行级解析:代码块(```围栏,内部灰显不再行内处理)、标题(#–######→粗体青)、分隔线(---→灰横线)、引用(>→ │ 前缀灰)、无序列表(-/*/+→•)、有序列表(数字.)、表格(|...| 且下一行是 |---| 分隔→按 CJK 宽度对齐渲染)、段落(行内格式)。行内:`` `码` ``→青、`**粗**`→粗、`*斜*`→斜。

- [ ] **Step 5: 失败测试 `src/tui/markdown.test.ts`(EXACT)**
```ts
import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./markdown.js";
import { displayWidth } from "./width.js";

// 去掉 ANSI 转义,便于断言可见内容/宽度
function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("renderMarkdown", () => {
  it("renders a header in bold (text preserved)", () => {
    const out = renderMarkdown("# 标题");
    expect(strip(out)).toContain("标题");
    expect(out).toContain("\x1b[1m"); // 粗体
  });

  it("renders inline bold and inline code", () => {
    const out = renderMarkdown("这是 **粗** 和 `码`");
    expect(out).toContain("\x1b[1m粗");
    expect(out).toContain("\x1b[36m码");
  });

  it("renders a fenced code block (content preserved, no inline processing)", () => {
    const out = renderMarkdown("```\nconst a = 1; // **不加粗**\n```");
    expect(strip(out)).toContain("const a = 1; // **不加粗**");
    expect(out).toContain("\x1b[2m"); // 灰显
    expect(out).not.toContain("\x1b[1m"); // 代码内不应被加粗
  });

  it("renders bullets", () => {
    const out = renderMarkdown("- 一\n- 二");
    expect(strip(out)).toContain("• 一");
    expect(strip(out)).toContain("• 二");
  });

  it("renders a CJK table with aligned columns", () => {
    const md = "| 名字 | 城市 |\n|---|---|\n| 张三 | 北京 |\n| 李 | 上海市 |";
    const out = renderMarkdown(md);
    const lines = strip(out).split("\n");
    expect(lines.some((l) => l.includes("┌"))).toBe(true); // 表框
    expect(lines.some((l) => l.includes("张三"))).toBe(true);
    // 两个 body 行的可见宽度一致(对齐)
    const body = lines.filter((l) => l.startsWith("│") && (l.includes("张三") || l.includes("李")));
    expect(body).toHaveLength(2);
    expect(displayWidth(body[0]!)).toBe(displayWidth(body[1]!));
  });
});
```

- [ ] **Step 6:** `npx vitest run src/tui/markdown.test.ts` — FAIL。

- [ ] **Step 7: 写 `src/tui/markdown.ts`(EXACT)**
```ts
import { displayWidth, padEnd } from "./width.js";

// 行内格式:`码`(青)、**粗**、*斜*。先按反引号切出代码段保护,其余做粗/斜替换。
function inline(text: string): string {
  return text
    .split(/(`[^`]+`)/g)
    .map((p) => {
      if (p.startsWith("`") && p.endsWith("`") && p.length >= 2) {
        return `\x1b[36m${p.slice(1, -1)}\x1b[39m`;
      }
      return p
        .replace(/\*\*(.+?)\*\*/g, "\x1b[1m$1\x1b[22m")
        .replace(/\*(.+?)\*/g, "\x1b[3m$1\x1b[23m");
    })
    .join("");
}

function parseRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function renderTable(rows: string[][]): string {
  const header = rows[0] ?? [];
  const body = rows.slice(2); // 跳过 |---| 分隔行
  const cols = header.length;
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let w = displayWidth(header[c] ?? "");
    for (const row of body) w = Math.max(w, displayWidth(row[c] ?? ""));
    widths[c] = w;
  }
  const bar = (l: string, m: string, r: string) =>
    l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
  const renderRow = (cells: string[], bold = false) =>
    "│ " +
    widths
      .map((w, c) => {
        const padded = padEnd(cells[c] ?? "", w);
        return bold ? `\x1b[1m${padded}\x1b[22m` : padded;
      })
      .join(" │ ") +
    " │";
  return [
    bar("┌", "┬", "┐"),
    renderRow(header, true),
    bar("├", "┼", "┤"),
    ...body.map((r) => renderRow(r)),
    bar("└", "┴", "┘"),
  ].join("\n");
}

export function renderMarkdown(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // 代码围栏
    if (/^\s*```/.test(line)) {
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) {
        out.push(`\x1b[2m  ${lines[i]}\x1b[22m`);
        i++;
      }
      i++; // 跳过结束围栏
      continue;
    }

    // 表格:本行以 | 起,下一行是分隔行
    if (
      /^\s*\|/.test(line) &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1]!)
    ) {
      const tbl: string[] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) {
        tbl.push(lines[i]!);
        i++;
      }
      out.push(renderTable(tbl.map(parseRow)));
      continue;
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push(`\x1b[1m\x1b[36m${inline(h[2]!)}\x1b[0m`);
      i++;
      continue;
    }

    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(`\x1b[2m${"─".repeat(40)}\x1b[22m`);
      i++;
      continue;
    }

    // 引用
    const bq = /^>\s?(.*)$/.exec(line);
    if (bq) {
      out.push(`\x1b[2m│\x1b[22m ${inline(bq[1]!)}`);
      i++;
      continue;
    }

    // 无序列表
    const bl = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bl) {
      out.push(`${bl[1]}• ${inline(bl[2]!)}`);
      i++;
      continue;
    }

    // 有序列表
    const nl = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
    if (nl) {
      out.push(`${nl[1]}${nl[2]}. ${inline(nl[3]!)}`);
      i++;
      continue;
    }

    // 段落 / 空行
    out.push(line.trim() === "" ? "" : inline(line));
    i++;
  }
  return out.join("\n");
}
```

- [ ] **Step 8:** `npx vitest run src/tui/markdown.test.ts` — 5 PASS。
- [ ] **Step 9:** `npx tsc --noEmit` — clean。
- [ ] **Step 10:** 提交
```bash
cd /Users/huaruoxu/ClaudeProject/career_plan/code/codeds
git add src/tui/width.ts src/tui/width.test.ts src/tui/markdown.ts src/tui/markdown.test.ts
git commit -m "feat(tui): CJK width + markdown-to-ANSI renderer"
```

---

## Task 2: 流式渲染器 + 接入 loop

**Files:** Create `src/tui/render.ts`, Test `src/tui/render.test.ts`; Modify `src/agent/loop.ts`

**契约:** `renderStream(gen, write): Promise<AssistantMessage>` —— 取代 loop 内联的 `renderTurn`:reasoning **实时灰显**;content **缓冲**;遇 tool_call 或消息结束时 `flush`(把缓冲的 content 经 `renderMarkdown` 整体写出);tool_call 用 `\x1b[36m→ 名\x1b[0m`。返回 generator 的返回值(AssistantMessage)。

- [ ] **Step 1: 失败测试 `src/tui/render.test.ts`(EXACT)**
```ts
import { describe, it, expect } from "vitest";
import { renderStream } from "./render.js";
import type { AssistantMessage, StreamDelta } from "../client/types.js";

function gen(deltas: StreamDelta[], message: AssistantMessage) {
  return (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
    for (const d of deltas) yield d;
    return message;
  })();
}
function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("renderStream", () => {
  it("streams reasoning then renders content as markdown, returns the message", async () => {
    const w: string[] = [];
    const msg = await renderStream(
      gen([{ kind: "reasoning", text: "思考中" }, { kind: "content", text: "# 标题" }], {
        role: "assistant",
        content: "# 标题",
      }),
      (s) => w.push(s),
    );
    const out = w.join("");
    expect(out).toContain("思考中"); // reasoning 实时
    expect(strip(out)).toContain("标题"); // content 渲染
    expect(out).toContain("\x1b[1m"); // markdown 粗体(标题)
    expect(msg).toEqual({ role: "assistant", content: "# 标题" });
  });

  it("flushes buffered content before a tool-call marker", async () => {
    const w: string[] = [];
    await renderStream(
      gen(
        [{ kind: "content", text: "正文" }, { kind: "tool_call", index: 0, name: "read_file" }],
        {
          role: "assistant",
          content: "正文",
          tool_calls: [{ id: "c0", type: "function", function: { name: "read_file", arguments: "{}" } }],
        },
      ),
      (s) => w.push(s),
    );
    const out = strip(w.join(""));
    expect(out.indexOf("正文")).toBeLessThan(out.indexOf("read_file")); // 内容先于工具标记
    expect(out).toContain("→ read_file");
  });
});
```

- [ ] **Step 2:** `npx vitest run src/tui/render.test.ts` — FAIL。

- [ ] **Step 3: 写 `src/tui/render.ts`(EXACT)**
```ts
import type { AssistantMessage, StreamDelta } from "../client/types.js";
import { renderMarkdown } from "./markdown.js";

// 驱动一轮流式:reasoning 实时灰显;content 缓冲到边界再整体 markdown 渲染;
// tool_call 青色标记。返回 generator 的返回值(拼好的 assistant 消息)。
export async function renderStream(
  gen: AsyncGenerator<StreamDelta, AssistantMessage>,
  write: (s: string) => void,
): Promise<AssistantMessage> {
  let inReasoning = false;
  let contentBuf = "";
  const flush = () => {
    if (contentBuf) {
      write(renderMarkdown(contentBuf));
      contentBuf = "";
    }
  };

  let r = await gen.next();
  while (!r.done) {
    const d = r.value;
    if (d.kind === "reasoning") {
      if (!inReasoning) {
        write("\x1b[90m");
        inReasoning = true;
      }
      write(d.text);
    } else if (d.kind === "content") {
      if (inReasoning) {
        write("\x1b[0m\n\n");
        inReasoning = false;
      }
      contentBuf += d.text;
    } else {
      // tool_call
      if (inReasoning) {
        write("\x1b[0m\n");
        inReasoning = false;
      }
      flush();
      write(`\x1b[36m→ ${d.name}\x1b[0m\n`);
    }
    r = await gen.next();
  }
  if (inReasoning) write("\x1b[0m");
  flush();
  write("\n");
  return r.value;
}
```

- [ ] **Step 4:** `npx vitest run src/tui/render.test.ts` — 2 PASS。

- [ ] **Step 5: 改 `src/agent/loop.ts`** —— 用 `renderStream` 取代内联 `renderTurn`:
  (a) 顶部加 import:`import { renderStream } from "../tui/render.js";`
  (b) **删除** loop.ts 里内联的 `async function renderTurn(...)` 整个函数。
  (c) 把 `runTurn` 里 `const assistant = await renderTurn(gen, deps.write);` 改为 `const assistant = await renderStream(gen, deps.write);`
  (其余 runTurn 逻辑——plan 分支、工具执行等——不变。)

- [ ] **Step 6:** `npx vitest run src/agent/loop.test.ts` — 仍全 PASS(runTurn 行为不变;loop 测试用 toContain/messages 断言,markdown 渲染纯文本后文字仍在)。若有个别精确断言因渲染细节失败,把它放宽为 toContain 对应可见文本。
- [ ] **Step 7:** `npx tsc --noEmit` — clean(确认 loop.ts 无残留 renderTurn 引用)。
- [ ] **Step 8: 全量测试** —— `npx vitest run`,全 PASS。在 M8 的 164 基础上新增 width(4)+markdown(5)+render(2)=11 ≈ **~175 用例**。报实际总数。
- [ ] **Step 9: 无网络冒烟** —— `DEEPSEEK_API_KEY= npm run dev -- "hi"` 退出 1;`printf '/help\n/exit\n' | DEEPSEEK_API_KEY=x npm run dev` 退出 0。
- [ ] **Step 10:** 提交
```bash
git add src/tui/render.ts src/tui/render.test.ts src/agent/loop.ts
git commit -m "feat(tui): streaming renderer with markdown content; wire into turn loop"
```

---

## Task 3: 真网络/端到端验收(markdown + CJK 表格渲染)

> key 桥接,不回显。**由 controller 执行。**

- [ ] **Step 1: 让模型输出 markdown(标题+列表+代码+CJK 表格)** ——
```bash
set -a && . ./.env && set +a && DEEPSEEK_API_KEY="$DS_API_KEY" npm run dev -- "用 markdown 给我一个小示例:一个二级标题、两条无序列表、一段行内代码、一个三行的中文表格(列:工具、用途;至少含 read_file 和 grep_files)。别调用工具,直接输出 markdown。" 2>&1; echo "---EXIT=$?---"
```
Expected:reasoning 灰显;正文渲染为:标题加粗青、列表 `•`、行内码青、**中文表格用 `┌┬┐│├┼┤└┴┘` 框线且列按 CJK 宽度对齐**(中文不会撑歪)。退出 0。肉眼确认表格对齐、各 markdown 元素有样式。

- [ ] **Step 2: 记录结论** —— 把 M9 验收结果一句话追加到设计文档 §11 末尾或加"M9 已落地"备注(markdown 渲染 + CJK 表格对齐 + 流式渲染器接入)。提交:
```bash
git add docs/2026-06-04-deepseek-coding-agent-design.md
git commit -m "docs: record M9 TUI acceptance — MVP complete"
```

---

## 验收标准(M9 完成 = MVP 完成)

- [ ] `npx vitest run` 全绿(约 175 用例)。
- [ ] `npx tsc --noEmit` 零错。
- [ ] 缺 key / REPL 命令冒烟正常。
- [ ] width:ASCII 计 1、CJK 计 2、padEnd CJK-aware(有测试)。
- [ ] markdown:标题/粗体/行内码/代码块(内部不被行内处理)/列表/**CJK 表格对齐**(两行可见宽度相等)(有测试)。
- [ ] render:reasoning 实时灰显、content 缓冲后 markdown 渲染、tool_call 标记、内容先于工具标记(有测试)。
- [ ] loop 改用 renderStream 后所有 loop 测试仍过。
- [ ] 真网络:模型输出的 markdown(含中文表格)在终端渲染正确、对齐。

## MVP 完成后的 carry-over(后续迭代)

- **增量 markdown**:现 content 缓冲到末尾才渲染(失去逐字感);可做边流边渲(难)。
- **审批/子代理展示**:审批提示、`[子代理开始/完成]` 可做更花哨/可折叠的展示。
- **自动折行**:超终端宽度的长行未折行;可加 CJK-aware 折行。
- **width 用 string-width**:自建 East-Asian-Width 覆盖常见范围;边角字符可换更全的 `string-width`。
- **表格单元格行内格式**:现单元格纯文本(保宽度正确);可在保宽前提下加粗体等。
- **累积的旧 carry-over**(MVP 后再清):项目指令文件加载、记忆 P2/P3、edit_file 越界测试、执行器并发回归测试、approval 三档、web_search 健壮性、注册顺序断言、§10 注入一次集成测试、compaction 端到端测试、子代理 real-loop 集成测试、subagentDepth undefined→1 测试、摘要/调查子代理用 flash 省钱、dist 构建/bin。

## MVP 全景(M9 完成后)

M1 走通骨架 → M2 工具循环 → M3 审批门+写/执行 → M4 工具补全 → M5 系统prompt+模式+REPL → M6 记忆P1 → M7 上下文压缩 → M8 子代理 → **M9 TUI 渲染**。
codeds = 交互式终端 coding agent:DeepSeek V4 流式 + 15 工具 + 审批门/PathEscape + normal/plan 模式 + 跨 session 记忆 + 自动/手动压缩 + 一次性子代理 + markdown/CJK 渲染。MVP 齐。