# codeds M4 — 工具补全 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐设计文档 §4 剩余工具:`grep_files`(按内容搜)、`file_search`(按文件名 glob 搜、按 mtime 排序)、`ask_user`(向用户提问)、`fetch_url`(抓网页→纯文本)、`web_search`(DuckDuckGo)、`todo_write`(单层任务清单)。

**Architecture:** 在 M3 的工具/注册表/审批/loop 上纯扩充,不改已有行为。新增共享原语 `tools/glob.ts`(glob→RegExp)与 `tools/walk.ts`(递归列文件、跳过常见忽略目录),被 grep_files/file_search 复用。`ToolContext` 再加两个可选注入能力:`ask?`(ask_user 用)与 `fetchImpl?`(网络工具用),延续 `readFiles` 的"会话能力袋"模式,使所有工具单测都能注入桩、不触网、不读真 stdin。文件类工具全部经 `resolveInWorkspace` 锁在工作区内。

**Tech Stack:** 沿用(Node20+/TS-ESM/vitest/zod/原生 fetch)。无新第三方依赖。web_search 抓 DuckDuckGo HTML(`https://html.duckduckgo.com/html/`),fetch_url 去标签取纯文本。

**外部决策(已与用户确认 2026-06-05)**:web_search 后端 = **DuckDuckGo(无 key,HTML 抓取,较脆弱但零配置)**;fetch_url = **去标签纯文本 + 截断**。

参考:设计文档 §4 工具集、§5 审批(`suggest` 在当前 gate 里 = 需审批)。M3 代码。

**范围与延后**:approval 三档(Auto/Suggest/Required)当前 gate 仍只区分 auto 与非 auto——`suggest` 暂等同 `required`(网络工具会提示),三档细分留后续。ripgrep 加速(现 grep 为纯 Node 遍历)、glob 的 `\` 路径分隔(现假定 `/`,darwin OK)、fetch_url 小模型预处理、todo 的 TUI 渲染——均 carry-over。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/tools/types.ts` | `ToolContext` 加 `ask?` / `fetchImpl?` | 改 |
| `src/tools/glob.ts` | `globToRegExp` | 新建 |
| `src/tools/walk.ts` | `walkFiles` 递归列文件(跳过忽略目录) | 新建 |
| `src/tools/grep_files.ts` | 按内容正则搜 | 新建 |
| `src/tools/file_search.ts` | 按文件名 glob 搜 + mtime 排序 | 新建 |
| `src/tools/ask_user.ts` | 向用户提问(经 ctx.ask) | 新建 |
| `src/tools/stdin_ask.ts` | readline 版 ask(供 index) | 新建 |
| `src/tools/fetch_url.ts` | 抓网页→去标签纯文本+截断 | 新建 |
| `src/tools/web_search.ts` | DuckDuckGo 搜索 | 新建 |
| `src/tools/todo_store.ts` | 任务清单单例 | 新建 |
| `src/tools/todo_write.ts` | 写任务清单 | 新建 |
| `src/index.ts` | 注册 6 个新工具 + ctx.ask/fetchImpl | 改 |

---

## Task 1: 搜索原语(ToolContext 扩展 + glob + walk)

**Files:** Modify `src/tools/types.ts`; Create `src/tools/glob.ts`, `src/tools/glob.test.ts`, `src/tools/walk.ts`, `src/tools/walk.test.ts`

- [ ] **Step 1: 改 `src/tools/types.ts` 的 `ToolContext`** 为:
```ts
export interface ToolContext {
  // 工具的文件根目录;路径相对它解析。
  workspaceRoot: string;
  // 本会话已读文件的绝对路径集合(写工具据此判断"覆盖/编辑前是否已读");可选。
  readFiles?: Set<string>;
  // 向用户提问(ask_user 用);注入,便于测试。
  ask?: (question: string) => Promise<string>;
  // 网络抓取(web_search/fetch_url 用);注入,默认全局 fetch。
  fetchImpl?: typeof fetch;
}
```
(其余类型不变;新增字段可选,不破坏现有 ctx 字面量。)

- [ ] **Step 2: 失败测试 `src/tools/glob.test.ts`(EXACT)**
```ts
import { describe, it, expect } from "vitest";
import { globToRegExp } from "./glob.js";

describe("globToRegExp", () => {
  it("matches a top-level star pattern but not across directories", () => {
    const re = globToRegExp("*.ts");
    expect(re.test("a.ts")).toBe(true);
    expect(re.test("sub/a.ts")).toBe(false);
    expect(re.test("a.js")).toBe(false);
  });

  it("matches ** across directories, including zero", () => {
    const re = globToRegExp("**/*.ts");
    expect(re.test("a.ts")).toBe(true);
    expect(re.test("sub/a.ts")).toBe(true);
    expect(re.test("a/b/c.ts")).toBe(true);
    expect(re.test("a.js")).toBe(false);
  });

  it("matches ? as a single non-slash char", () => {
    const re = globToRegExp("?.ts");
    expect(re.test("a.ts")).toBe(true);
    expect(re.test("ab.ts")).toBe(false);
  });

  it("treats a directory prefix literally", () => {
    const re = globToRegExp("src/*.ts");
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("lib/a.ts")).toBe(false);
  });

  it("escapes regex-special characters in literals", () => {
    const re = globToRegExp("a.b+c.txt");
    expect(re.test("a.b+c.txt")).toBe(true);
    expect(re.test("aXbXc.txt")).toBe(false);
  });
});
```

- [ ] **Step 3:** `npx vitest run src/tools/glob.test.ts` — FAIL。

- [ ] **Step 4: 写 `src/tools/glob.ts`(EXACT)**
```ts
// 把 glob(支持 * ** ?)转成锚定的 RegExp,匹配以 / 分隔的相对路径。
// * 不跨目录;** 跨任意层(含 0 层,后接 / 时);? 匹配单个非 / 字符。
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}
```

- [ ] **Step 5:** `npx vitest run src/tools/glob.test.ts` — 5 PASS。

- [ ] **Step 6: 失败测试 `src/tools/walk.test.ts`(EXACT)**
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { walkFiles } from "./walk.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codeds-walk-"));
  await fs.writeFile(path.join(root, "a.txt"), "x", "utf8");
  await fs.mkdir(path.join(root, "sub"));
  await fs.writeFile(path.join(root, "sub", "b.txt"), "y", "utf8");
  await fs.mkdir(path.join(root, "node_modules"));
  await fs.writeFile(path.join(root, "node_modules", "skip.txt"), "z", "utf8");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function collect(root: string) {
  const out: string[] = [];
  for await (const f of walkFiles(root)) out.push(f.rel);
  return out.sort();
}

describe("walkFiles", () => {
  it("yields files recursively with relative paths", async () => {
    const rels = await collect(root);
    expect(rels).toContain("a.txt");
    expect(rels).toContain(path.join("sub", "b.txt"));
  });

  it("skips ignored directories like node_modules", async () => {
    const rels = await collect(root);
    expect(rels.some((r) => r.includes("node_modules"))).toBe(false);
  });
});
```

- [ ] **Step 7:** `npx vitest run src/tools/walk.test.ts` — FAIL。

- [ ] **Step 8: 写 `src/tools/walk.ts`(EXACT)**
```ts
import { promises as fs } from "node:fs";
import path from "node:path";

const IGNORE = new Set(["node_modules", ".git", "dist", ".codeds"]);

// 递归列出 root 下的所有文件(跳过常见忽略目录),返回绝对路径与相对 root 的路径。
export async function* walkFiles(
  root: string,
): AsyncGenerator<{ abs: string; rel: string }> {
  async function* rec(dir: string): AsyncGenerator<{ abs: string; rel: string }> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE.has(e.name)) continue;
        yield* rec(abs);
      } else if (e.isFile()) {
        yield { abs, rel: path.relative(root, abs) };
      }
    }
  }
  yield* rec(root);
}
```

- [ ] **Step 9:** `npx vitest run src/tools/walk.test.ts` — 2 PASS。
- [ ] **Step 10:** `npx tsc --noEmit` — clean。
- [ ] **Step 11:** 提交
```bash
cd /Users/huaruoxu/ClaudeProject/career_plan/code/codeds
git add src/tools/types.ts src/tools/glob.ts src/tools/glob.test.ts src/tools/walk.ts src/tools/walk.test.ts
git commit -m "feat(tools): glob + walk primitives; ToolContext ask/fetchImpl"
```

---

## Task 2: grep_files

**Files:** Create `src/tools/grep_files.ts`, Test `src/tools/grep_files.test.ts`

**契约:** 参数 `{ pattern; path?; glob?; mode?: "content"|"files"; ignore_case? }`。`resolveInWorkspace(path ?? ".")` 为根,`walkFiles` 遍历;`glob` 过滤文件名(basename);跳过含 `\u0000` 的二进制;按 `new RegExp(pattern, ignore_case?"i":"")` 逐行测;content 模式输出 `rel:行号:行内容`(行截 300 字、总条数封顶 200),files 模式输出命中文件名;无匹配返回 `(无匹配)`;超限追加截断提示。capability "read",approval "auto"。

- [ ] **Step 1: 失败测试 `src/tools/grep_files.test.ts`(EXACT)**
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { grepFilesTool } from "./grep_files.js";

let root: string;
function ctx() {
  return { workspaceRoot: root };
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codeds-grep-"));
  await fs.writeFile(path.join(root, "a.ts"), "const foo = 1;\nconst bar = 2;\n", "utf8");
  await fs.writeFile(path.join(root, "b.md"), "foo appears here\n", "utf8");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("grep_files tool", () => {
  it("returns path:line:content for content mode", async () => {
    const out = await grepFilesTool.handler({ pattern: "foo" }, ctx());
    expect(out).toContain("a.ts:1:const foo = 1;");
    expect(out).toContain("b.md:1:foo appears here");
  });

  it("returns only filenames in files mode", async () => {
    const out = await grepFilesTool.handler({ pattern: "foo", mode: "files" }, ctx());
    expect(out).toContain("a.ts");
    expect(out).toContain("b.md");
    expect(out).not.toContain(":1:");
  });

  it("filters by filename glob", async () => {
    const out = await grepFilesTool.handler({ pattern: "foo", glob: "*.ts" }, ctx());
    expect(out).toContain("a.ts");
    expect(out).not.toContain("b.md");
  });

  it("honors ignore_case", async () => {
    const out = await grepFilesTool.handler({ pattern: "FOO", ignore_case: true }, ctx());
    expect(out).toContain("a.ts:1:");
  });

  it("returns (无匹配) when nothing matches", async () => {
    const out = await grepFilesTool.handler({ pattern: "zzz-nope" }, ctx());
    expect(out).toBe("(无匹配)");
  });

  it("declares read capability and auto approval", () => {
    expect(grepFilesTool.capability).toBe("read");
    expect(grepFilesTool.approval).toBe("auto");
    expect(grepFilesTool.name).toBe("grep_files");
  });
});
```

- [ ] **Step 2:** `npx vitest run src/tools/grep_files.test.ts` — FAIL。

- [ ] **Step 3: 写 `src/tools/grep_files.ts`(EXACT)**
```ts
import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool } from "./types.js";
import { resolveInWorkspace } from "./paths.js";
import { walkFiles } from "./walk.js";
import { globToRegExp } from "./glob.js";

const MAX = 200;

export const grepFilesTool = defineTool({
  name: "grep_files",
  description:
    "在工作区内按内容(正则)搜索文本文件。mode=content(默认)返回 路径:行号:行内容;mode=files 只返回命中文件名。可用 glob 过滤文件名。",
  capability: "read",
  approval: "auto",
  schema: z.object({
    pattern: z.string().describe("正则表达式"),
    path: z.string().optional().describe("搜索子目录,默认工作区根"),
    glob: z.string().optional().describe("文件名 glob 过滤,如 *.ts"),
    mode: z.enum(["content", "files"]).optional().describe("content(默认)或 files"),
    ignore_case: z.boolean().optional().describe("忽略大小写"),
  }),
  handler: async (args, ctx) => {
    const root = resolveInWorkspace(ctx.workspaceRoot, args.path ?? ".");
    let re: RegExp;
    try {
      re = new RegExp(args.pattern, args.ignore_case ? "i" : "");
    } catch (e) {
      throw new Error(`无效正则:${(e as Error).message}`);
    }
    const nameRe = args.glob ? globToRegExp(args.glob) : null;
    const mode = args.mode ?? "content";
    const contentLines: string[] = [];
    const fileHits: string[] = [];
    let truncated = false;

    outer: for await (const { abs, rel } of walkFiles(root)) {
      const base = rel.split(/[/\\]/).pop()!;
      if (nameRe && !nameRe.test(base)) continue;
      let raw: string;
      try {
        raw = await fs.readFile(abs, "utf8");
      } catch {
        continue;
      }
      if (raw.includes("\u0000")) continue; // 跳过二进制
      const lines = raw.split("\n");
      let fileMatched = false;
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          fileMatched = true;
          if (mode === "content") {
            contentLines.push(`${rel}:${i + 1}:${lines[i]!.slice(0, 300)}`);
            if (contentLines.length >= MAX) {
              truncated = true;
              break outer;
            }
          } else {
            break;
          }
        }
      }
      if (mode === "files" && fileMatched) {
        fileHits.push(rel);
        if (fileHits.length >= MAX) {
          truncated = true;
          break;
        }
      }
    }

    const out = mode === "content" ? contentLines : fileHits;
    if (out.length === 0) return "(无匹配)";
    return out.join("\n") + (truncated ? `\n…(已截断,超过 ${MAX} 条)` : "");
  },
});
```

- [ ] **Step 4:** `npx vitest run src/tools/grep_files.test.ts` — 6 PASS。
- [ ] **Step 5:** `npx tsc --noEmit` — clean。
- [ ] **Step 6:** 提交
```bash
git add src/tools/grep_files.ts src/tools/grep_files.test.ts
git commit -m "feat(tools): grep_files content/files search"
```

---

## Task 3: file_search

**Files:** Create `src/tools/file_search.ts`, Test `src/tools/file_search.test.ts`

**契约:** 参数 `{ glob; path? }`。`resolveInWorkspace(path ?? ".")` 为根,`walkFiles` 遍历,`globToRegExp(glob)` 匹配相对路径;命中文件按 mtime 从新到旧排序,封顶 100;无匹配返回 `(无匹配)`。capability "read",approval "auto"。

- [ ] **Step 1: 失败测试 `src/tools/file_search.test.ts`(EXACT)**
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileSearchTool } from "./file_search.js";

let root: string;
function ctx() {
  return { workspaceRoot: root };
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codeds-filesearch-"));
  await fs.writeFile(path.join(root, "old.ts"), "x", "utf8");
  await fs.writeFile(path.join(root, "new.ts"), "y", "utf8");
  await fs.mkdir(path.join(root, "sub"));
  await fs.writeFile(path.join(root, "sub", "deep.ts"), "z", "utf8");
  await fs.writeFile(path.join(root, "note.md"), "m", "utf8");
  await fs.utimes(path.join(root, "old.ts"), new Date(1000), new Date(1000));
  await fs.utimes(path.join(root, "new.ts"), new Date(2000), new Date(2000));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("file_search tool", () => {
  it("finds top-level files by glob, newest first", async () => {
    const out = await fileSearchTool.handler({ glob: "*.ts" }, ctx());
    const lines = out.split("\n");
    expect(lines).toEqual(["new.ts", "old.ts"]); // new.ts has later mtime
  });

  it("finds nested files with ** glob", async () => {
    const out = await fileSearchTool.handler({ glob: "**/*.ts" }, ctx());
    expect(out).toContain(path.join("sub", "deep.ts"));
    expect(out).toContain("new.ts");
  });

  it("returns (无匹配) when nothing matches", async () => {
    const out = await fileSearchTool.handler({ glob: "*.json" }, ctx());
    expect(out).toBe("(无匹配)");
  });

  it("declares read capability and auto approval", () => {
    expect(fileSearchTool.capability).toBe("read");
    expect(fileSearchTool.approval).toBe("auto");
    expect(fileSearchTool.name).toBe("file_search");
  });
});
```

- [ ] **Step 2:** `npx vitest run src/tools/file_search.test.ts` — FAIL。

- [ ] **Step 3: 写 `src/tools/file_search.ts`(EXACT)**
```ts
import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool } from "./types.js";
import { resolveInWorkspace } from "./paths.js";
import { walkFiles } from "./walk.js";
import { globToRegExp } from "./glob.js";

const MAX = 100;

export const fileSearchTool = defineTool({
  name: "file_search",
  description: "在工作区内按文件名/路径 glob 搜索文件(如 *.ts 或 **/*.test.ts),按修改时间从新到旧排序。",
  capability: "read",
  approval: "auto",
  schema: z.object({
    glob: z.string().describe("文件名/路径 glob"),
    path: z.string().optional().describe("搜索子目录,默认工作区根"),
  }),
  handler: async (args, ctx) => {
    const root = resolveInWorkspace(ctx.workspaceRoot, args.path ?? ".");
    const re = globToRegExp(args.glob);
    const hits: { rel: string; mtime: number }[] = [];
    for await (const { abs, rel } of walkFiles(root)) {
      if (!re.test(rel)) continue;
      try {
        const st = await fs.stat(abs);
        hits.push({ rel, mtime: st.mtimeMs });
      } catch {
        continue;
      }
    }
    if (hits.length === 0) return "(无匹配)";
    hits.sort((a, b) => b.mtime - a.mtime);
    return hits
      .slice(0, MAX)
      .map((h) => h.rel)
      .join("\n");
  },
});
```

- [ ] **Step 4:** `npx vitest run src/tools/file_search.test.ts` — 4 PASS。
- [ ] **Step 5:** `npx tsc --noEmit` — clean。
- [ ] **Step 6:** 提交
```bash
git add src/tools/file_search.ts src/tools/file_search.test.ts
git commit -m "feat(tools): file_search by glob sorted by mtime"
```

---

## Task 4: ask_user(+ stdin_ask)

**Files:** Create `src/tools/ask_user.ts`, `src/tools/stdin_ask.ts`, Test `src/tools/ask_user.test.ts`

**契约:** `ask_user` 参数 `{ question }`。用 `ctx.ask` 提问并返回答案(trim;空答返回 `(用户未回答)`);`ctx.ask` 未配置则抛错。capability "read",approval "auto"。`stdin_ask` 是 readline 版实现(供 index 注入,不单测)。

- [ ] **Step 1: 失败测试 `src/tools/ask_user.test.ts`(EXACT)**
```ts
import { describe, it, expect } from "vitest";
import { askUserTool } from "./ask_user.js";

describe("ask_user tool", () => {
  it("returns the user's answer via ctx.ask", async () => {
    const out = await askUserTool.handler(
      { question: "favorite color?" },
      { workspaceRoot: "/tmp", ask: async () => "blue" },
    );
    expect(out).toBe("blue");
  });

  it("passes the question to ctx.ask", async () => {
    let asked = "";
    await askUserTool.handler(
      { question: "which env?" },
      { workspaceRoot: "/tmp", ask: async (q) => { asked = q; return "prod"; } },
    );
    expect(asked).toBe("which env?");
  });

  it("returns a placeholder when the answer is empty", async () => {
    const out = await askUserTool.handler(
      { question: "x?" },
      { workspaceRoot: "/tmp", ask: async () => "   " },
    );
    expect(out).toBe("(用户未回答)");
  });

  it("throws when ask is not configured", async () => {
    await expect(
      askUserTool.handler({ question: "x?" }, { workspaceRoot: "/tmp" }),
    ).rejects.toThrow(/ask 未配置/);
  });

  it("declares auto approval", () => {
    expect(askUserTool.approval).toBe("auto");
    expect(askUserTool.name).toBe("ask_user");
  });
});
```

- [ ] **Step 2:** `npx vitest run src/tools/ask_user.test.ts` — FAIL。

- [ ] **Step 3: 写 `src/tools/ask_user.ts`(EXACT)**
```ts
import { z } from "zod";
import { defineTool } from "./types.js";

export const askUserTool = defineTool({
  name: "ask_user",
  description:
    "向用户提出一个澄清问题并等待自由文本回答。仅在缺少关键信息、且无法用其它工具获取时使用;一次只问一个。",
  capability: "read",
  approval: "auto",
  schema: z.object({
    question: z.string().describe("要问用户的问题"),
  }),
  handler: async (args, ctx) => {
    if (!ctx.ask) throw new Error("当前环境不支持向用户提问(ask 未配置)");
    const answer = (await ctx.ask(args.question)).trim();
    return answer ? answer : "(用户未回答)";
  },
});
```

- [ ] **Step 4: 写 `src/tools/stdin_ask.ts`(EXACT)**
```ts
import { createInterface } from "node:readline/promises";

// 命令行版 ask:打印问题,读一行回答。供 index 注入到 ctx.ask。
export async function stdinAsk(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`\n${question}\n> `);
    return await rl.question("");
  } finally {
    rl.close();
  }
}
```

- [ ] **Step 5:** `npx vitest run src/tools/ask_user.test.ts` — 5 PASS。
- [ ] **Step 6:** `npx tsc --noEmit` — clean。
- [ ] **Step 7:** 提交
```bash
git add src/tools/ask_user.ts src/tools/stdin_ask.ts src/tools/ask_user.test.ts
git commit -m "feat(tools): ask_user via injected ctx.ask + stdin impl"
```

---

## Task 5: fetch_url

**Files:** Create `src/tools/fetch_url.ts`, Test `src/tools/fetch_url.test.ts`

**契约:** 参数 `{ url; max_chars? }`。`ctx.fetchImpl ?? fetch` GET;非 2xx 抛错;读 text,去 script/style/标签、解码常见实体、压空白,截到 `max_chars`(默认 20000),超出追加 `…(已截断)`。capability "network",approval "suggest"。

- [ ] **Step 1: 失败测试 `src/tools/fetch_url.test.ts`(EXACT)**
```ts
import { describe, it, expect } from "vitest";
import { fetchUrlTool } from "./fetch_url.js";

function fetchReturning(html: string, status = 200): typeof fetch {
  return (async () => new Response(html, { status })) as unknown as typeof fetch;
}

describe("fetch_url tool", () => {
  it("strips tags, script/style, and decodes entities", async () => {
    const html =
      "<html><head><style>.x{}</style></head><body><script>evil()</script><p>Hi &amp; bye</p></body></html>";
    const out = await fetchUrlTool.handler(
      { url: "https://example.com" },
      { workspaceRoot: "/tmp", fetchImpl: fetchReturning(html) },
    );
    expect(out).toContain("Hi & bye");
    expect(out).not.toContain("<p>");
    expect(out).not.toContain("evil()");
    expect(out).not.toContain(".x{}");
  });

  it("truncates to max_chars", async () => {
    const html = "<p>" + "a".repeat(500) + "</p>";
    const out = await fetchUrlTool.handler(
      { url: "https://example.com", max_chars: 100 },
      { workspaceRoot: "/tmp", fetchImpl: fetchReturning(html) },
    );
    expect(out).toContain("…(已截断)");
    expect(out.length).toBeLessThan(160);
  });

  it("throws on non-2xx", async () => {
    await expect(
      fetchUrlTool.handler(
        { url: "https://example.com" },
        { workspaceRoot: "/tmp", fetchImpl: fetchReturning("x", 404) },
      ),
    ).rejects.toThrow(/404/);
  });

  it("declares network capability and suggest approval", () => {
    expect(fetchUrlTool.capability).toBe("network");
    expect(fetchUrlTool.approval).toBe("suggest");
    expect(fetchUrlTool.name).toBe("fetch_url");
  });
});
```

- [ ] **Step 2:** `npx vitest run src/tools/fetch_url.test.ts` — FAIL。

- [ ] **Step 3: 写 `src/tools/fetch_url.ts`(EXACT)**
```ts
import { z } from "zod";
import { defineTool } from "./types.js";

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export const fetchUrlTool = defineTool({
  name: "fetch_url",
  description: "抓取一个网页 URL,返回去掉标签后的纯文本(超长会截断)。",
  capability: "network",
  approval: "suggest",
  schema: z.object({
    url: z.string().url().describe("要抓取的 http(s) URL"),
    max_chars: z.number().int().min(100).optional().describe("最多返回字符数,默认 20000"),
  }),
  handler: async (args, ctx) => {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const res = await fetchImpl(args.url);
    if (!res.ok) throw new Error(`抓取失败 HTTP ${res.status}`);
    const html = await res.text();
    const text = htmlToText(html);
    const max = args.max_chars ?? 20000;
    return text.length > max ? text.slice(0, max) + "\n…(已截断)" : text;
  },
});
```

- [ ] **Step 4:** `npx vitest run src/tools/fetch_url.test.ts` — 4 PASS。
- [ ] **Step 5:** `npx tsc --noEmit` — clean。
- [ ] **Step 6:** 提交
```bash
git add src/tools/fetch_url.ts src/tools/fetch_url.test.ts
git commit -m "feat(tools): fetch_url to stripped plain text"
```

---

## Task 6: web_search(DuckDuckGo)

**Files:** Create `src/tools/web_search.ts`, Test `src/tools/web_search.test.ts`

**契约:** 参数 `{ query; max_results? }`。`ctx.fetchImpl ?? fetch` GET `https://html.duckduckgo.com/html/?q=<query>`(带 UA);非 2xx 抛错;正则抽取 `result__a`(href+标题)与 `result__snippet`,href 若是 `/l/?uddg=` 重定向则解码出真实 URL;按序配对成"序号. 标题 / URL / 摘要",封顶 `max_results`(默认 5);无结果返回 `(无搜索结果)`。capability "network",approval "suggest"。

> DDG HTML 结构可能变动,解析较脆弱(用户已知悉);单测用固定 fixture 保证解析逻辑稳定,真实可用性在 Task 9 实测。

- [ ] **Step 1: 失败测试 `src/tools/web_search.test.ts`(EXACT)**
```ts
import { describe, it, expect } from "vitest";
import { webSearchTool } from "./web_search.js";

const FIXTURE = `
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x">Title <b>A</b></a>
  <a class="result__snippet">Snippet A &amp; more</a>
</div>
<div class="result">
  <a class="result__a" href="https://example.com/b">Title B</a>
  <a class="result__snippet">Snippet B</a>
</div>
`;

function fetchReturning(html: string, status = 200): typeof fetch {
  return (async () => new Response(html, { status })) as unknown as typeof fetch;
}

describe("web_search tool", () => {
  it("parses titles, decoded urls, and snippets from DDG html", async () => {
    const out = await webSearchTool.handler(
      { query: "anything" },
      { workspaceRoot: "/tmp", fetchImpl: fetchReturning(FIXTURE) },
    );
    expect(out).toContain("Title A");
    expect(out).toContain("https://example.com/a"); // uddg decoded
    expect(out).toContain("Snippet A & more");
    expect(out).toContain("Title B");
    expect(out).toContain("https://example.com/b");
  });

  it("honors max_results", async () => {
    const out = await webSearchTool.handler(
      { query: "x", max_results: 1 },
      { workspaceRoot: "/tmp", fetchImpl: fetchReturning(FIXTURE) },
    );
    expect(out).toContain("Title A");
    expect(out).not.toContain("Title B");
  });

  it("returns (无搜索结果) when html has no results", async () => {
    const out = await webSearchTool.handler(
      { query: "x" },
      { workspaceRoot: "/tmp", fetchImpl: fetchReturning("<html></html>") },
    );
    expect(out).toBe("(无搜索结果)");
  });

  it("throws on non-2xx", async () => {
    await expect(
      webSearchTool.handler(
        { query: "x" },
        { workspaceRoot: "/tmp", fetchImpl: fetchReturning("x", 503) },
      ),
    ).rejects.toThrow(/503/);
  });

  it("declares network capability and suggest approval", () => {
    expect(webSearchTool.capability).toBe("network");
    expect(webSearchTool.approval).toBe("suggest");
    expect(webSearchTool.name).toBe("web_search");
  });
});
```

- [ ] **Step 2:** `npx vitest run src/tools/web_search.test.ts` — FAIL。

- [ ] **Step 3: 写 `src/tools/web_search.ts`(EXACT)**
```ts
import { z } from "zod";
import { defineTool } from "./types.js";

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function decodeDdgUrl(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]!);
    } catch {
      return href;
    }
  }
  return href.startsWith("//") ? "https:" + href : href;
}

export const webSearchTool = defineTool({
  name: "web_search",
  description: "用 DuckDuckGo 联网搜索,返回若干条结果(标题、URL、摘要)。",
  capability: "network",
  approval: "suggest",
  schema: z.object({
    query: z.string().describe("搜索关键词"),
    max_results: z.number().int().min(1).max(10).optional().describe("返回结果数,默认 5"),
  }),
  handler: async (args, ctx) => {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`;
    const res = await fetchImpl(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`搜索失败 HTTP ${res.status}`);
    const html = await res.text();
    const max = args.max_results ?? 5;

    const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snipRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

    const links: { url: string; title: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(html)) !== null && links.length < max) {
      links.push({ url: decodeDdgUrl(m[1]!), title: stripTags(m[2]!) });
    }
    const snippets: string[] = [];
    while ((m = snipRe.exec(html)) !== null && snippets.length < max) {
      snippets.push(stripTags(m[1]!));
    }

    if (links.length === 0) return "(无搜索结果)";
    return links
      .map((l, i) => `${i + 1}. ${l.title}\n   ${l.url}\n   ${snippets[i] ?? ""}`.trimEnd())
      .join("\n\n");
  },
});
```

- [ ] **Step 4:** `npx vitest run src/tools/web_search.test.ts` — 5 PASS。
- [ ] **Step 5:** `npx tsc --noEmit` — clean。
- [ ] **Step 6:** 提交
```bash
git add src/tools/web_search.ts src/tools/web_search.test.ts
git commit -m "feat(tools): web_search via DuckDuckGo html"
```

---

## Task 7: todo_write(+ todo_store)

**Files:** Create `src/tools/todo_store.ts`, `src/tools/todo_write.ts`, Test `src/tools/todo_write.test.ts`

**契约:** `todo_write` 参数 `{ todos: [{ content; status: pending|in_progress|completed }] }`(整表覆盖)。校验:in_progress 至多 1 个(否则抛错);写入 `todoStore`;返回带图标的渲染(`☐/▶/☑`);空列表返回 `(任务清单已清空)`。capability "plan",approval "auto"。

- [ ] **Step 1: 失败测试 `src/tools/todo_write.test.ts`(EXACT)**
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { todoWriteTool } from "./todo_write.js";
import { todoStore } from "./todo_store.js";

beforeEach(() => todoStore.reset());
const ctx = { workspaceRoot: "/tmp" };

describe("todo_write tool", () => {
  it("renders todos with status icons and stores them", async () => {
    const out = await todoWriteTool.handler(
      {
        todos: [
          { content: "design", status: "completed" },
          { content: "build", status: "in_progress" },
          { content: "test", status: "pending" },
        ],
      },
      ctx,
    );
    expect(out).toContain("☑ design");
    expect(out).toContain("▶ build");
    expect(out).toContain("☐ test");
    expect(todoStore.get()).toHaveLength(3);
  });

  it("rejects more than one in_progress", async () => {
    await expect(
      todoWriteTool.handler(
        {
          todos: [
            { content: "a", status: "in_progress" },
            { content: "b", status: "in_progress" },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow(/in_progress/);
  });

  it("clears the list when given an empty array", async () => {
    const out = await todoWriteTool.handler({ todos: [] }, ctx);
    expect(out).toBe("(任务清单已清空)");
    expect(todoStore.get()).toHaveLength(0);
  });

  it("declares plan capability and auto approval", () => {
    expect(todoWriteTool.capability).toBe("plan");
    expect(todoWriteTool.approval).toBe("auto");
    expect(todoWriteTool.name).toBe("todo_write");
  });
});
```

- [ ] **Step 2:** `npx vitest run src/tools/todo_write.test.ts` — FAIL。

- [ ] **Step 3: 写 `src/tools/todo_store.ts`(EXACT)**
```ts
export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  content: string;
  status: TodoStatus;
}

class TodoStore {
  private todos: Todo[] = [];
  set(todos: Todo[]): void {
    this.todos = todos;
  }
  get(): Todo[] {
    return this.todos;
  }
  reset(): void {
    this.todos = [];
  }
}

export const todoStore = new TodoStore();
```

- [ ] **Step 4: 写 `src/tools/todo_write.ts`(EXACT)**
```ts
import { z } from "zod";
import { defineTool } from "./types.js";
import { todoStore, type TodoStatus } from "./todo_store.js";

const ICON: Record<TodoStatus, string> = {
  pending: "☐",
  in_progress: "▶",
  completed: "☑",
};

export const todoWriteTool = defineTool({
  name: "todo_write",
  description:
    "维护单层任务清单(每次整表替换)。状态 pending/in_progress/completed;同一时刻最多一个 in_progress。用于拆解多步任务、边做边更新。",
  capability: "plan",
  approval: "auto",
  schema: z.object({
    todos: z
      .array(
        z.object({
          content: z.string(),
          status: z.enum(["pending", "in_progress", "completed"]),
        }),
      )
      .describe("完整任务列表"),
  }),
  handler: async (args) => {
    const inProgress = args.todos.filter((t) => t.status === "in_progress").length;
    if (inProgress > 1) {
      throw new Error(`同一时刻最多一个 in_progress,当前有 ${inProgress} 个`);
    }
    todoStore.set(args.todos);
    if (args.todos.length === 0) return "(任务清单已清空)";
    return args.todos.map((t) => `${ICON[t.status]} ${t.content}`).join("\n");
  },
});
```

- [ ] **Step 5:** `npx vitest run src/tools/todo_write.test.ts` — 4 PASS。
- [ ] **Step 6:** `npx tsc --noEmit` — clean。
- [ ] **Step 7:** 提交
```bash
git add src/tools/todo_store.ts src/tools/todo_write.ts src/tools/todo_write.test.ts
git commit -m "feat(tools): todo_write single-layer task list"
```

---

## Task 8: 装配 index + 全量验收

**Files:** Modify `src/index.ts`

- [ ] **Step 1: 改 `src/index.ts`** ——
  1) 增加 import:
```ts
import { grepFilesTool } from "./tools/grep_files.js";
import { fileSearchTool } from "./tools/file_search.js";
import { askUserTool } from "./tools/ask_user.js";
import { fetchUrlTool } from "./tools/fetch_url.js";
import { webSearchTool } from "./tools/web_search.js";
import { todoWriteTool } from "./tools/todo_write.js";
import { stdinAsk } from "./tools/stdin_ask.js";
```
  2) 在已有 7 个 `registry.register(...)` 之后,按固定顺序追加 6 个:
```ts
  registry.register(grepFilesTool);
  registry.register(fileSearchTool);
  registry.register(askUserTool);
  registry.register(fetchUrlTool);
  registry.register(webSearchTool);
  registry.register(todoWriteTool);
```
  3) 把 `runAgent` 的 `ctx` 改为带上 ask/fetchImpl:
```ts
    ctx: { workspaceRoot, readFiles: new Set<string>(), ask: stdinAsk, fetchImpl: fetch },
```
  (其余 index 不变。)

- [ ] **Step 2: 全量 typecheck** —— `npx tsc --noEmit`。Expected:退出码 0,零错误。
- [ ] **Step 3: 全量测试** —— `npx vitest run`。Expected:全 PASS。预期新增文件:glob、walk、grep_files、file_search、ask_user、fetch_url、web_search、todo_write;在 M3 的 80 基础上 +约 35 ≈ **115 用例**。报实际总数。
- [ ] **Step 4: 无网络冒烟** ——
  `DEEPSEEK_API_KEY= npm run dev -- "hi"` → 含 "Missing DEEPSEEK_API_KEY",退出 1。
  `DEEPSEEK_API_KEY=x npm run dev` → 用法行,退出 1。
- [ ] **Step 5:** 提交
```bash
cd /Users/huaruoxu/ClaudeProject/career_plan/code/codeds
git add src/index.ts
git commit -m "feat: register grep/file_search/ask_user/fetch_url/web_search/todo_write"
```

---

## Task 9: 真网络/端到端验收

> 需有效 key,会触网+计费。key 桥接 `DS_API_KEY`→`DEEPSEEK_API_KEY`,不回显。fetch_url/web_search 是 `suggest` 会触发审批,用管道喂 `y`。**由 controller 执行。**

- [ ] **Step 1: 本地工具(无网络)——grep + todo** ——
```bash
set -a && . ./.env && set +a && DEEPSEEK_API_KEY="$DS_API_KEY" npm run dev -- "先用 todo_write 列出两步:1 搜索 streamChat 2 报告;然后用 grep_files 在 src 里搜 streamChat,告诉我它定义在哪个文件" 2>&1
```
Expected:出现 `→ todo_write`(auto,无审批)与 `→ grep_files`(auto),模型据 grep 结果指出 `src/client/client.ts`。退出 0。

- [ ] **Step 2: fetch_url(网络 + 审批)** ——
```bash
set -a && . ./.env && set +a && printf 'y\n' | DEEPSEEK_API_KEY="$DS_API_KEY" npm run dev -- "用 fetch_url 抓取 https://example.com,用一句话说它是什么" 2>&1
```
Expected:`→ fetch_url` + 审批提示 + `y` 放行 + 抓到 "Example Domain" 文本 + 模型作答。退出 0。

- [ ] **Step 3: web_search(网络 + 审批,可能脆弱)** ——
```bash
set -a && . ./.env && set +a && printf 'y\n' | DEEPSEEK_API_KEY="$DS_API_KEY" npm run dev -- "用 web_search 搜 'DeepSeek V4 API',列出前 3 条结果标题" 2>&1
```
Expected:`→ web_search` + 审批 + `y` + 返回若干结果。**若 DDG 限流/改版导致 0 结果或解析失败**:记录现象——单测已用 fixture 锁定解析逻辑;真实可用性问题记为 carry-over(可换 Tavily/Brave),不阻塞 M4。

- [ ] **Step 4: 记录结论** —— 把 M4 验收结果(6 工具是否端到端可用、web_search 实测是否成功)一句话追加到设计文档 §4 末尾或一个"M4 已落地"备注。提交:
```bash
git add docs/architecture/overview.md
git commit -m "docs: record M4 tool-completion acceptance"
```

---

## 验收标准(M4 完成的定义)

- [ ] `npx vitest run` 全绿(约 115 用例)。
- [ ] `npx tsc --noEmit` 零错。
- [ ] 缺 key / 无参数冒烟退出 1。
- [ ] grep_files content/files/glob/ignore_case/无匹配 均有测试;file_search glob/mtime 排序/无匹配有测试。
- [ ] ask_user 经注入 ctx.ask 可测;fetch_url 去标签+截断+非2xx 有测试;web_search 解析+max+无结果+非2xx 有测试(fixture)。
- [ ] todo_write 渲染+单 in_progress 约束+清空 有测试。
- [ ] 文件类工具经 resolveInWorkspace 锁工作区。
- [ ] 真网络:grep/todo 本地可用;fetch_url 经审批抓取成功;web_search 实测(成功或记录脆弱)。

## 给后续里程碑留的 carry-over

- **approval 三档**:实现 `suggest`(默认放行+提示 / 软门)区别于 `required`;网络工具用 suggest 而非现在的"等同 required"。
- **web_search 健壮性**:DDG 抓取脆弱;可切 Tavily/Brave(需 key)或加重试/多源。
- **grep 加速**:可选 ripgrep 后端(rg 在则用、否则回退纯 Node)。
- **glob 路径分隔**:现假定 `/`;Windows 的 `\` 需归一化。
- **fetch_url 预处理**:大页面接小模型摘要(设计 §4 后期项)。
- **todo TUI**:todoStore 已留;M9 在 TUI 持续渲染当前清单。
- **M3 carry-over 仍在**:edit_file 越界测试、执行器并发回归测试、审批 summary preview。
