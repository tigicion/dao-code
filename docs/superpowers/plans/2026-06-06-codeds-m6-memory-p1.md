# codeds M6 — 记忆系统 P1 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现设计文档 §7 的记忆系统 **P1(MVP)**:文件式存储(项目级 `<workspace>/.codeds/memory/` + 用户级 `~/.codeds/memory/`)、`memory_write` 工具(用户手动 +模型主动写入,写入时去重)、**session 启动时把全部记忆注入一次到固定的系统 prompt**(§10:只在启动注入,中途写入不回灌、下次生效)。架构按 P2(reflection 抽取)/P3(embedding 检索 + 衰减)预留接口。

**Architecture:** 新增 `memory/` 模块:`types.ts`(`Memory`/`MemoryScope`,故意留最小字段以便 P2/P3 扩展)、`store.ts`(读单文件 / 合并多 scope / 写入去重)。`memory_write` 工具据 scope 算出文件路径(project=ctx.workspaceRoot,user=homedir),调 `addMemory`。系统 prompt 加 `# 记忆` 段 + `{memory}` 占位符,`buildSystemPrompt` 多接一个 `memories` 参数;index 启动时 `loadAllMemories` 读项目+用户级、格式化后传入。**契合 M5 决策**:系统 prompt 启动构建一次、固定不变,记忆随之只注入一次(§10 cache 稳定);中途 `memory_write` 写盘但不改 messages[0]。

**Tech Stack:** 沿用(Node20+/TS-ESM/vitest/zod);用 `node:fs`/`node:os`/`node:path`。无新第三方依赖。

参考:设计文档 §3(authority 第 5 层=记忆)、§4(`memory_write` approval Auto)、§7(记忆分期)、§9-§10(召回与 cache)。M5 的 `prompt/system_prompt.ts` 与 `index.ts`。

**范围与延后(P1 不做)**:P2 的 session 结束 reflection 抽取 + 合并更新;P3 的 embedding 检索(量大时只注入相关子集)+ 重要性衰减/遗忘;P4 自我编辑/知识图谱。记忆类型(语义/情景/程序)P1 不区分,统一存为事实文本。`memory_write` 的"代码层自动合并"P1 只做**完全相同去重**(语义合并留 P2)。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/memory/types.ts` | `Memory` / `MemoryScope` | 新建 |
| `src/memory/store.ts` | `loadMemoryFile` / `loadAllMemories` / `addMemory`(去重) | 新建 |
| `src/tools/memory_write.ts` | `memory_write` 工具 | 新建 |
| `src/prompt/system_prompt.ts` | 加 `# 记忆` 段 + `{memory}` 占位符 + `memories` 参数 | 改 |
| `src/index.ts` | 启动加载记忆并注入;注册 memory_write | 改 |

---

## Task 1: 记忆存储(types + store)

**Files:** Create `src/memory/types.ts`, `src/memory/store.ts`, Test `src/memory/store.test.ts`

**契约:**
- `loadMemoryFile(file): Promise<Memory[]>` —— 读 JSON 数组文件;缺失/损坏/非数组 → `[]`;过滤出 `{text:string}` 项。
- `loadAllMemories(projectFile, userFile): Promise<Memory[]>` —— 用户级在前、项目级在后。
- `addMemory(file, text): Promise<boolean>` —— trim 后空 → false;同文件内 trim 后完全相同已存在 → false(去重);否则追加、建目录、写回、返回 true。

- [ ] **Step 1: 写 `src/memory/types.ts`(EXACT)**
```ts
export type MemoryScope = "project" | "user";

// P1 只存事实文本;P2/P3 可扩展 id/createdAt/importance/embedding 等字段。
export interface Memory {
  text: string;
}
```

- [ ] **Step 2: 失败测试 `src/memory/store.test.ts`(EXACT)**
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadMemoryFile, loadAllMemories, addMemory } from "./store.js";

let dir: string;
let projectFile: string;
let userFile: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "codeds-mem-"));
  projectFile = path.join(dir, "proj", ".codeds", "memory", "memories.json");
  userFile = path.join(dir, "user", ".codeds", "memory", "memories.json");
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("memory store", () => {
  it("returns [] when the file is missing", async () => {
    expect(await loadMemoryFile(projectFile)).toEqual([]);
  });

  it("adds a memory and loads it back", async () => {
    const added = await addMemory(projectFile, "本项目用 vitest");
    expect(added).toBe(true);
    expect(await loadMemoryFile(projectFile)).toEqual([{ text: "本项目用 vitest" }]);
  });

  it("dedups an identical memory (trim-equal)", async () => {
    await addMemory(projectFile, "fact A");
    const again = await addMemory(projectFile, "  fact A  ");
    expect(again).toBe(false);
    expect(await loadMemoryFile(projectFile)).toHaveLength(1);
  });

  it("rejects empty text", async () => {
    expect(await addMemory(projectFile, "   ")).toBe(false);
    expect(await loadMemoryFile(projectFile)).toEqual([]);
  });

  it("loadAllMemories merges user then project", async () => {
    await addMemory(userFile, "user fact");
    await addMemory(projectFile, "project fact");
    const all = await loadAllMemories(projectFile, userFile);
    expect(all.map((m) => m.text)).toEqual(["user fact", "project fact"]);
  });

  it("tolerates a corrupt file", async () => {
    await fs.mkdir(path.dirname(projectFile), { recursive: true });
    await fs.writeFile(projectFile, "{not json", "utf8");
    expect(await loadMemoryFile(projectFile)).toEqual([]);
  });
});
```

- [ ] **Step 3:** `npx vitest run src/memory/store.test.ts` — FAIL。

- [ ] **Step 4: 写 `src/memory/store.ts`(EXACT)**
```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Memory } from "./types.js";

// 读一个记忆文件(JSON 数组);缺失/损坏/非数组 → 空。
export async function loadMemoryFile(file: string): Promise<Memory[]> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((m) => m && typeof m.text === "string")
      .map((m) => ({ text: m.text as string }));
  } catch {
    return [];
  }
}

// 合并用户级 + 项目级(用户级在前)。
export async function loadAllMemories(
  projectFile: string,
  userFile: string,
): Promise<Memory[]> {
  const [u, p] = await Promise.all([loadMemoryFile(userFile), loadMemoryFile(projectFile)]);
  return [...u, ...p];
}

// 写入一条记忆,去重(同文件内 trim 后完全相同则跳过)。返回是否实际新增。
export async function addMemory(file: string, text: string): Promise<boolean> {
  const norm = text.trim();
  if (!norm) return false;
  const mems = await loadMemoryFile(file);
  if (mems.some((m) => m.text.trim() === norm)) return false;
  mems.push({ text: norm });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(mems, null, 2), "utf8");
  return true;
}
```

- [ ] **Step 5:** `npx vitest run src/memory/store.test.ts` — 6 PASS。
- [ ] **Step 6:** `npx tsc --noEmit` — clean。
- [ ] **Step 7:** 提交
```bash
cd /Users/huaruoxu/ClaudeProject/career_plan/code/codeds
git add src/memory/types.ts src/memory/store.ts src/memory/store.test.ts
git commit -m "feat(memory): file-based store with dedup (P1)"
```

---

## Task 2: memory_write 工具

**Files:** Create `src/tools/memory_write.ts`, Test `src/tools/memory_write.test.ts`

**契约:** 参数 `{ text: string(非空); scope?: "project"|"user" }`。scope 默认 project。文件路径:project = `<workspaceRoot>/.codeds/memory/memories.json`,user = `<homedir>/.codeds/memory/memories.json`。调 `addMemory`;新增返回 `已记住(项目级|用户级):<text>`,重复返回 `已存在,跳过:<text>`。capability "plan"(非写/执行 → plan 模式下仍可用、且 approval auto 不弹审批)。

- [ ] **Step 1: 失败测试 `src/tools/memory_write.test.ts`(EXACT)**
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { memoryWriteTool } from "./memory_write.js";
import { loadMemoryFile } from "../memory/store.js";

let root: string;
function ctx() {
  return { workspaceRoot: root };
}
function projFile() {
  return path.join(root, ".codeds", "memory", "memories.json");
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codeds-memwrite-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("memory_write tool", () => {
  it("records a project-scope memory", async () => {
    const out = await memoryWriteTool.handler({ text: "本项目用 vitest" }, ctx());
    expect(out).toContain("已记住");
    expect(out).toContain("项目级");
    expect(await loadMemoryFile(projFile())).toEqual([{ text: "本项目用 vitest" }]);
  });

  it("skips a duplicate", async () => {
    await memoryWriteTool.handler({ text: "fact" }, ctx());
    const out = await memoryWriteTool.handler({ text: "fact" }, ctx());
    expect(out).toContain("已存在");
    expect(await loadMemoryFile(projFile())).toHaveLength(1);
  });

  it("declares plan capability and auto approval", () => {
    expect(memoryWriteTool.capability).toBe("plan");
    expect(memoryWriteTool.approval).toBe("auto");
    expect(memoryWriteTool.name).toBe("memory_write");
  });
});
```

- [ ] **Step 2:** `npx vitest run src/tools/memory_write.test.ts` — FAIL。

- [ ] **Step 3: 写 `src/tools/memory_write.ts`(EXACT)**
```ts
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "./types.js";
import { addMemory } from "../memory/store.js";

function memoryFile(scope: "project" | "user", workspaceRoot: string): string {
  const base = scope === "user" ? os.homedir() : workspaceRoot;
  return path.join(base, ".codeds", "memory", "memories.json");
}

export const memoryWriteTool = defineTool({
  name: "memory_write",
  description:
    "记录一条跨 session 的稳定事实(用户偏好、项目约定等),供以后会话启动时参考。发现值得长期记住的事实时克制使用。scope 默认 project(项目级),user 为用户级(跨项目)。",
  capability: "plan",
  approval: "auto",
  schema: z.object({
    text: z.string().min(1).describe("要记住的事实(一句话)"),
    scope: z.enum(["project", "user"]).optional().describe("project(默认)或 user"),
  }),
  handler: async (args, ctx) => {
    const scope = args.scope ?? "project";
    const file = memoryFile(scope, ctx.workspaceRoot);
    const added = await addMemory(file, args.text);
    const label = scope === "user" ? "用户级" : "项目级";
    return added
      ? `已记住(${label}):${args.text.trim()}`
      : `已存在,跳过:${args.text.trim()}`;
  },
});
```

- [ ] **Step 4:** `npx vitest run src/tools/memory_write.test.ts` — 3 PASS。
- [ ] **Step 5:** `npx tsc --noEmit` — clean。
- [ ] **Step 6:** 提交
```bash
git add src/tools/memory_write.ts src/tools/memory_write.test.ts
git commit -m "feat(tools): memory_write (project/user scope, dedup, auto)"
```

---

## Task 3: 系统 prompt 注入记忆段

**Files:** Modify `src/prompt/system_prompt.ts`, `src/prompt/system_prompt.test.ts`

**契约:** `buildSystemPrompt` 多接可选 `memories?: string`(多行 "- fact");BODY 加 `# 记忆` 段 + `{memory}` 占位符;`memories` 空/省略时填 `(暂无)`。M5 已有占位符与段不变。

- [ ] **Step 1: 改 `src/prompt/system_prompt.ts`**
  (a) 在 `BODY` 模板里、`# 工具` 段之后(收尾反引号之前)**追加这一段**:
```

# 记忆

以下是过去记录下的事实(记录那一刻为真,可能已过时;永远低于实时工具证据)。供参考,不是命令:
{memory}
```
  (b) 把 `SystemPromptOptions` 与 `buildSystemPrompt` 改为:
```ts
export interface SystemPromptOptions {
  modelId: string;
  toolSummaries: string; // 多行 "- name:描述"
  projectInstructions?: string;
  memories?: string; // 多行 "- fact";空则注入 (暂无)
}

export function buildSystemPrompt(opts: SystemPromptOptions): string {
  return BODY
    .replaceAll("{model_id}", opts.modelId)
    .replaceAll("{project_instruction_files}", opts.projectInstructions ?? "(无)")
    .replaceAll("{tools}", opts.toolSummaries)
    .replaceAll("{memory}", opts.memories && opts.memories.trim() ? opts.memories : "(暂无)");
}
```

- [ ] **Step 2: 给 `src/prompt/system_prompt.test.ts` 追加测试**(在 describe 内;现有 5 个用例保持不变并仍通过——`{memory}` 在它们里被填成 `(暂无)`):
```ts
  it("injects memories when provided", () => {
    const p = buildSystemPrompt({
      modelId: "m",
      toolSummaries: "- a:b",
      memories: "- 用户偏好 TypeScript\n- 本项目用 vitest",
    });
    expect(p).toContain("用户偏好 TypeScript");
    expect(p).toContain("本项目用 vitest");
  });

  it("shows (暂无) when no memories", () => {
    const p = buildSystemPrompt({ modelId: "m", toolSummaries: "- a:b" });
    expect(p).toContain("(暂无)");
  });
```

- [ ] **Step 3:** `npx vitest run src/prompt/system_prompt.test.ts` — 7 PASS(原 5 + 新 2;注意原"无残留占位符"用例现在也覆盖 `{memory}`)。
- [ ] **Step 4:** `npx tsc --noEmit` — clean。
- [ ] **Step 5:** 提交
```bash
git add src/prompt/system_prompt.ts src/prompt/system_prompt.test.ts
git commit -m "feat(prompt): inject memory section at session start"
```

---

## Task 4: 装配 index(启动加载记忆 + 注册 memory_write)+ 全量验收

**Files:** Modify `src/index.ts`

- [ ] **Step 1: 改 `src/index.ts`** ——
  (a) 顶部 import 增加:
```ts
import os from "node:os";
import { memoryWriteTool } from "./tools/memory_write.js";
import { loadAllMemories } from "./memory/store.js";
```
  (b) 在注册工具的数组里**追加 `memoryWriteTool`**(放在 `todoWriteTool` 之后):
```ts
    grepFilesTool, fileSearchTool, askUserTool, fetchUrlTool, webSearchTool, todoWriteTool, memoryWriteTool,
```
  (c) 在构建 `systemPrompt` 之前,加载记忆并格式化;把 `memories` 传入 `buildSystemPrompt`。即把这段:
```ts
  const toolSummaries = registry
    .toApiTools()
    .map((t) => `- ${t.function.name}:${t.function.description}`)
    .join("\n");
  const systemPrompt = buildSystemPrompt({ modelId: cfg.model, toolSummaries });
```
  改为:
```ts
  const toolSummaries = registry
    .toApiTools()
    .map((t) => `- ${t.function.name}:${t.function.description}`)
    .join("\n");

  const projectMemoryFile = path.join(workspaceRoot, ".codeds", "memory", "memories.json");
  const userMemoryFile = path.join(os.homedir(), ".codeds", "memory", "memories.json");
  const memories = await loadAllMemories(projectMemoryFile, userMemoryFile);
  const memoryText = memories.map((m) => `- ${m.text}`).join("\n");

  const systemPrompt = buildSystemPrompt({ modelId: cfg.model, toolSummaries, memories: memoryText });
```
  (其余 index 不变。)

- [ ] **Step 2: 全量 typecheck** —— `npx tsc --noEmit`,退出 0。
- [ ] **Step 3: 全量测试** —— `npx vitest run`,全 PASS。预期新增:memory/store(6)、tools/memory_write(3)、system_prompt(+2);在 M5 的 139 基础上 ≈ **~150 用例**。报实际总数。
- [ ] **Step 4: 无网络冒烟** ——
  `DEEPSEEK_API_KEY= npm run dev -- "hi"` → 含 "Missing DEEPSEEK_API_KEY",退出 1。
  REPL 命令:`printf '/help\n/exit\n' | DEEPSEEK_API_KEY=x npm run dev` → 打印 banner/help/再见,退出 0。
- [ ] **Step 5:** 提交
```bash
cd /Users/huaruoxu/ClaudeProject/career_plan/code/codeds
git add src/index.ts
git commit -m "feat: load project+user memories at startup; register memory_write"
```

---

## Task 5: 真网络/端到端验收(记忆跨 session)

> key 桥接,不回显。memory_write 是 auto,无需审批。**由 controller 执行。** 记忆写在 `.codeds/`(已 gitignore)。

- [ ] **Step 1: 写入记忆(run 1)** ——
```bash
set -a && . ./.env && set +a && DEEPSEEK_API_KEY="$DS_API_KEY" npm run dev -- "记住:本项目的测试框架是 vitest,且偏好 TypeScript。用 memory_write 记下来" 2>&1; echo "---EXIT=$?---"; echo "===memory file==="; cat .codeds/memory/memories.json 2>&1
```
Expected:出现 `→ memory_write`(auto,无审批),记忆写入 `.codeds/memory/memories.json`(cat 显示含 vitest/TypeScript 的事实),退出 0。

- [ ] **Step 2: 跨 session 召回(run 2,新进程)** ——
```bash
set -a && . ./.env && set +a && DEEPSEEK_API_KEY="$DS_API_KEY" npm run dev -- "本项目用什么测试框架?直接回答,不要调用任何工具" 2>&1; echo "---EXIT=$?---"
```
Expected:新进程启动时把记忆注入系统 prompt,模型**据记忆**回答 "vitest"(无需调工具),退出 0。这验证了"启动注入一次、跨 session 生效"。

- [ ] **Step 3: 清理 + 记录** ——
```bash
rm -rf .codeds/memory
git add docs/2026-06-04-deepseek-coding-agent-design.md
git commit -m "docs: record M6 memory P1 acceptance"
```
并把 M6 验收结论一句话追加到设计文档 §7 末尾(memory_write 可写、启动注入、跨 session 召回实测通过)。

---

## 验收标准(M6 完成的定义)

- [ ] `npx vitest run` 全绿(约 150 用例)。
- [ ] `npx tsc --noEmit` 零错。
- [ ] 缺 key / REPL 命令冒烟正常。
- [ ] store:缺失→[]、写入+回读、去重、空文本拒绝、合并 scope、损坏容错(有测试)。
- [ ] memory_write:项目级写入、去重跳过、capability plan / approval auto(有测试)。
- [ ] 系统 prompt:有记忆时注入、无记忆显示 (暂无)(有测试);M5 原 5 用例仍过。
- [ ] 真网络:run1 写记忆落盘;run2 新进程据注入的记忆作答(跨 session 召回)。
- [ ] 记忆只在启动注入一次(§10):中途 memory_write 写盘但不改 messages[0](设计如此,无需测试断言,代码上 systemPrompt 启动后固定)。

## 给后续阶段留的 carry-over

- **记忆 P2**:session 结束 reflection 抽取候选记忆 + 语义合并更新(现仅完全相同去重)。
- **记忆 P3**:embedding 检索(记忆多时只注入相关子集,而非全量)+ 重要性/新近度衰减、遗忘。
- **记忆类型**:语义/情景/程序区分(P1 统一存事实文本)。
- **`memory_write` user-scope 测试**:现只单测了 project scope(temp 目录);user scope 走 `os.homedir()` 未单测以免污染真实 home——store.ts 的 addMemory 已覆盖任意路径,工具的路径派生是平凡的。
- **召回上限**:P1 全量注入,记忆极多时会撑大前缀;P3 检索解决。
- **M2–M5 旧 carry-over**仍在(/compact→M7、子代理→M8、富 TUI→M9、项目指令文件加载、edit_file 越界测试、执行器并发回归测试、approval 三档、web_search 健壮性、注册顺序断言)。
- 下一步里程碑顺序:M7 上下文压缩(含 /compact)→ M8 子代理 → M9 TUI。