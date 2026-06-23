# codeds M3 — 审批门 + PathEscape + 写/执行工具 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 引入**审批门**(第一次有"需用户批准才执行"的工具)、给所有文件工具加 **PathEscape**(锁在 workspace 内),并落地写/执行工具:`write_file`、`edit_file`、`exec_shell`(前台+后台)、`exec_shell_poll`、`exec_shell_kill`。审批支持 **once / session / always**(always 持久化到项目配置)。

**Architecture:** 在 M2 的注册表+并发执行器+turn loop 上扩展。新增 `approval/` 模块:审批门据 `capability→approval` 与 session/always 放行表判定,合并多工具为一次提示;always 授权落盘 `.codeds/approvals.json`。新增 `tools/paths.ts` 的 `resolveInWorkspace` 做越界防护,所有文件工具改用它。后台进程由 `tools/process_manager.ts` 的模块级单例管理(spawn、累积输出、计数器 id)。执行器升级为**审批感知**:auto 工具立即并发(不被审批阻塞),gated 工具合并成一次提示后并发执行,被拒返回"用户拒绝"。审批提示函数注入,单测不读 stdin。

**Tech Stack:** 沿用 M2(Node20+/TS-ESM/vitest/tsx/zod)。新增用到 `node:child_process`、`node:readline/promises`。无新第三方依赖。

参考:设计文档 `docs/architecture/overview.md`(§4 工具、§5 权限/审批、§12 执行时序)。M2 计划与代码。M2 整体复审记下的 carry-over:PathEscape、接 capability/approval、list_dir 排序。

**范围与延后(M3 不做)**:细粒度 shell allowlist/denylist(exec-policy)、网络域名 policy、sandbox-policy —— 留到后续;M3 的 exec 仅"整体需审批"。plan 模式禁写/执行(M5)。审批提示的 UI 仅命令行 readline(富 TUI 在 M9)。tool 的 `preview(args)` 自定义摘要(现用原始 JSON 参数作摘要)留作 carry-over。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/tools/paths.ts` | `resolveInWorkspace` 越界防护 | 新建 |
| `src/tools/types.ts` | `ToolContext` 加 `readFiles?` | 改 |
| `src/tools/read_file.ts` / `list_dir.ts` | 改用 resolveInWorkspace;read_file 记录已读;list_dir 排序修正 | 改 |
| `src/approval/types.ts` | `ApprovalRequest`/`ApprovalDecision`/`ApprovalPrompt`/`ApprovalGate` 接口 | 新建 |
| `src/approval/store.ts` | always 放行表持久化(load/append) | 新建 |
| `src/approval/gate.ts` | `SessionApprovalGate`(once/session/always) | 新建 |
| `src/approval/stdin_prompt.ts` | readline 审批提示(真实交互) | 新建 |
| `src/tools/write_file.ts` | 新建/覆盖文件(覆盖前需已读) | 新建 |
| `src/tools/edit_file.ts` | 唯一字符串替换(改前需已读) | 新建 |
| `src/tools/process_manager.ts` | 后台进程单例管理 | 新建 |
| `src/tools/exec_shell.ts` | 跑命令(前台+后台) | 新建 |
| `src/tools/exec_shell_poll.ts` / `exec_shell_kill.ts` | 读/杀后台进程 | 新建 |
| `src/tools/execute.ts` | 升级为审批感知 | 改 |
| `src/agent/loop.ts` | 穿透 gate 给执行器 | 改 |
| `src/index.ts` | 装配 gate + 注册 5 个新工具 + ctx.readFiles | 改 |

---

## Task 1: PathEscape 助手

**Files:** Create `src/tools/paths.ts`, Test `src/tools/paths.test.ts`

**契约:** `resolveInWorkspace(workspaceRoot, p): string` —— 把 `p` 相对 `workspaceRoot` 解析为绝对路径;若解析结果落在 workspace 之外(含 `..` 越界、绝对路径越界)抛 `路径越界`。`p` 指向根目录本身(如 `.`)合法。

- [ ] **Step 1: 失败测试 `src/tools/paths.test.ts`(EXACT)**
```ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { resolveInWorkspace } from "./paths.js";

const root = path.resolve("/tmp/ws");

describe("resolveInWorkspace", () => {
  it("resolves a relative path inside the workspace", () => {
    expect(resolveInWorkspace(root, "a.txt")).toBe(path.join(root, "a.txt"));
    expect(resolveInWorkspace(root, "sub/b.txt")).toBe(path.join(root, "sub", "b.txt"));
  });

  it("allows the workspace root itself", () => {
    expect(resolveInWorkspace(root, ".")).toBe(root);
  });

  it("normalizes harmless .. that stays inside", () => {
    expect(resolveInWorkspace(root, "sub/../a.txt")).toBe(path.join(root, "a.txt"));
  });

  it("rejects traversal escaping the workspace", () => {
    expect(() => resolveInWorkspace(root, "../etc/passwd")).toThrow(/越界/);
    expect(() => resolveInWorkspace(root, "sub/../../x")).toThrow(/越界/);
  });

  it("rejects absolute paths outside the workspace", () => {
    expect(() => resolveInWorkspace(root, "/etc/passwd")).toThrow(/越界/);
  });
});
```

- [ ] **Step 2:** `npx vitest run src/tools/paths.test.ts` — FAIL(模块缺失)。

- [ ] **Step 3: 实现 `src/tools/paths.ts`(EXACT)**
```ts
import path from "node:path";

// 把 p 相对 workspaceRoot 解析为绝对路径;拒绝任何落在 workspace 之外的结果。
export function resolveInWorkspace(workspaceRoot: string, p: string): string {
  const root = path.resolve(workspaceRoot);
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel === "") return abs; // 根目录本身
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`路径越界:${p} 超出工作区`);
  }
  return abs;
}
```

- [ ] **Step 4:** `npx vitest run src/tools/paths.test.ts` — 5 用例 PASS。
- [ ] **Step 5:** `npx tsc --noEmit` — clean。
- [ ] **Step 6:** 提交
```bash
cd /Users/huaruoxu/ClaudeProject/career_plan/code/codeds
git add src/tools/paths.ts src/tools/paths.test.ts
git commit -m "feat(tools): resolveInWorkspace path-escape guard"
```

---

## Task 2: ToolContext 加 readFiles;read_file / list_dir 接 PathEscape

**Files:** Modify `src/tools/types.ts`, `src/tools/read_file.ts`, `src/tools/list_dir.ts`, and their tests.

**说明:** `ToolContext` 增加可选 `readFiles?: Set<string>`(本会话已读文件的绝对路径,供写工具做"覆盖前需已读"判断)。read_file 改用 `resolveInWorkspace` 并在成功读取后把绝对路径加入 `readFiles`。list_dir 改用 `resolveInWorkspace`,并修正 M2 Minor:**先按原始名排序再加 `/`**。

- [ ] **Step 1: 改 `src/tools/types.ts`** —— 把 `ToolContext` 改为:
```ts
export interface ToolContext {
  // 工具的文件根目录;路径相对它解析。
  workspaceRoot: string;
  // 本会话已读文件的绝对路径集合(写工具据此判断"覆盖/编辑前是否已读");可选。
  readFiles?: Set<string>;
}
```
(其余类型不变。)

- [ ] **Step 2: 给 read_file 加越界测试 + 已读记录测试** —— 在 `src/tools/read_file.test.ts` 的 describe 内追加:
```ts
  it("rejects paths escaping the workspace", async () => {
    await expect(
      readFileTool.handler({ path: "../escape.txt" }, { workspaceRoot: root }),
    ).rejects.toThrow(/越界/);
  });

  it("records the read file's absolute path in ctx.readFiles", async () => {
    const seen = new Set<string>();
    await readFileTool.handler({ path: "a.txt" }, { workspaceRoot: root, readFiles: seen });
    expect(seen.has(path.join(root, "a.txt"))).toBe(true);
  });
```

- [ ] **Step 3: 改 `src/tools/read_file.ts` 的 handler** —— 用 resolveInWorkspace 并记录已读:
```ts
import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool } from "./types.js";
import { resolveInWorkspace } from "./paths.js";

export const readFileTool = defineTool({
  name: "read_file",
  description:
    "读取工作区内的文本文件,返回带行号(1-based)的内容。可用 offset 指定起始行、limit 指定读取行数。",
  capability: "read",
  approval: "auto",
  schema: z.object({
    path: z.string().describe("相对工作区根目录的文件路径"),
    offset: z.number().int().min(1).optional().describe("起始行号(1-based,含)"),
    limit: z.number().int().min(1).optional().describe("最多读取的行数"),
  }),
  handler: async (args, ctx) => {
    const abs = resolveInWorkspace(ctx.workspaceRoot, args.path);
    const raw = await fs.readFile(abs, "utf8");
    ctx.readFiles?.add(abs);
    const lines = raw.split("\n");
    const start = args.offset ? args.offset - 1 : 0;
    const end = args.limit !== undefined ? start + args.limit : lines.length;
    return lines
      .slice(start, end)
      .map((line, i) => `${start + i + 1}\t${line}`)
      .join("\n");
  },
});
```
(注意:`read_file.test.ts` 顶部需 `import path from "node:path";` 才能用上面的断言——若尚无则加上。)

- [ ] **Step 4: 给 list_dir 加越界测试** —— 在 `src/tools/list_dir.test.ts` describe 内追加:
```ts
  it("rejects paths escaping the workspace", async () => {
    await expect(listDirTool.handler({ path: ".." }, { workspaceRoot: root })).rejects.toThrow(/越界/);
  });
```

- [ ] **Step 5: 改 `src/tools/list_dir.ts` 的 handler** —— 用 resolveInWorkspace 并先排序后加斜杠:
```ts
import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool } from "./types.js";
import { resolveInWorkspace } from "./paths.js";

export const listDirTool = defineTool({
  name: "list_dir",
  description: "列出工作区内某个目录的条目,目录名以 / 结尾,按字典序排列。",
  capability: "read",
  approval: "auto",
  schema: z.object({
    path: z.string().optional().describe("相对工作区根目录的目录路径,默认根目录"),
  }),
  handler: async (args, ctx) => {
    const abs = resolveInWorkspace(ctx.workspaceRoot, args.path ?? ".");
    const entries = await fs.readdir(abs, { withFileTypes: true });
    if (entries.length === 0) return "(空目录)";
    return [...entries]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .join("\n");
  },
});
```

- [ ] **Step 6:** `npx vitest run src/tools/read_file.test.ts src/tools/list_dir.test.ts` — 全 PASS(read_file 6、list_dir 5)。
- [ ] **Step 7:** `npx tsc --noEmit` — clean(`readFiles?` 可选,不破坏现有 ctx 字面量)。
- [ ] **Step 8:** 提交
```bash
git add src/tools/types.ts src/tools/read_file.ts src/tools/read_file.test.ts src/tools/list_dir.ts src/tools/list_dir.test.ts
git commit -m "feat(tools): path-escape + read tracking; fix list_dir sort"
```

---

## Task 3: 审批类型 + always 放行表持久化

**Files:** Create `src/approval/types.ts`, `src/approval/store.ts`, Test `src/approval/store.test.ts`

- [ ] **Step 1: 写 `src/approval/types.ts`(EXACT)**
```ts
import type { Capability, Tool } from "../tools/types.js";

// 一次审批请求(对应一个待批准的 tool_call)。
export interface ApprovalRequest {
  id: string; // tool_call id
  toolName: string;
  capability: Capability;
  summary: string; // 给用户看的摘要(M3:工具名 + 原始 JSON 参数)
}

export type ApprovalDecision = "once" | "session" | "always" | "deny";

// 提示函数:给一批请求,返回每个 id 的决定。注入(命令行/测试各自实现)。
export type ApprovalPrompt = (
  requests: ApprovalRequest[],
) => Promise<Map<string, ApprovalDecision>>;

// 审批门:执行器据此判定某工具是否需要批准、并批量请求批准。
export interface ApprovalGate {
  needsApproval(tool: Tool): boolean;
  requestBatch(requests: ApprovalRequest[]): Promise<Map<string, boolean>>;
}
```

- [ ] **Step 2: 失败测试 `src/approval/store.test.ts`(EXACT)**
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAlwaysApproved, appendAlwaysApproved } from "./store.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "codeds-approvals-"));
  file = path.join(dir, ".codeds", "approvals.json");
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("always-approved store", () => {
  it("returns an empty set when the file is missing", async () => {
    const set = await loadAlwaysApproved(file);
    expect(set.size).toBe(0);
  });

  it("persists and reloads approved tool names", async () => {
    await appendAlwaysApproved(file, "write_file");
    const set = await loadAlwaysApproved(file);
    expect(set.has("write_file")).toBe(true);
  });

  it("does not duplicate an already-approved tool", async () => {
    await appendAlwaysApproved(file, "write_file");
    await appendAlwaysApproved(file, "write_file");
    const raw = await fs.readFile(file, "utf8");
    expect(JSON.parse(raw)).toEqual(["write_file"]);
  });
});
```

- [ ] **Step 3:** `npx vitest run src/approval/store.test.ts` — FAIL(模块缺失)。

- [ ] **Step 4: 写 `src/approval/store.ts`(EXACT)**
```ts
import { promises as fs } from "node:fs";
import path from "node:path";

// 读取 always 放行表(工具名集合);文件缺失或损坏→空集。
export async function loadAlwaysApproved(file: string): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

// 把一个工具名追加进 always 放行表(已存在则不重复)。
export async function appendAlwaysApproved(file: string, toolName: string): Promise<void> {
  const current = await loadAlwaysApproved(file);
  if (current.has(toolName)) return;
  current.add(toolName);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify([...current], null, 2), "utf8");
}
```

- [ ] **Step 5:** `npx vitest run src/approval/store.test.ts` — 3 用例 PASS。
- [ ] **Step 6:** `npx tsc --noEmit` — clean。
- [ ] **Step 7:** 提交
```bash
git add src/approval/types.ts src/approval/store.ts src/approval/store.test.ts
git commit -m "feat(approval): approval types and always-approved persistence"
```

---

## Task 4: 审批门 SessionApprovalGate

**Files:** Create `src/approval/gate.ts`, Test `src/approval/gate.test.ts`

**契约:** `SessionApprovalGate implements ApprovalGate`,构造参数 `(prompt: ApprovalPrompt, alwaysApproved: Set<string>, persist: (toolName) => Promise<void>)`。
- `needsApproval(tool)`:`tool.approval !== "auto"` 且工具名不在 session 放行表、也不在 always 放行表。
- `requestBatch(requests)`:调一次 `prompt`,对每个请求:`session`→记入 session 放行表;`always`→记入 always 放行表并 `await persist(name)`;返回 `id→boolean`(`deny` 为 false,其余 true)。缺失决定按 `deny`。

- [ ] **Step 1: 失败测试 `src/approval/gate.test.ts`(EXACT)**
```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { SessionApprovalGate } from "./gate.js";
import { defineTool } from "../tools/types.js";
import type { ApprovalDecision, ApprovalRequest } from "./types.js";

const readTool = defineTool({
  name: "read_file", description: "", capability: "read", approval: "auto",
  schema: z.object({}), handler: async () => "",
});
const writeTool = defineTool({
  name: "write_file", description: "", capability: "write", approval: "required",
  schema: z.object({}), handler: async () => "",
});

function req(id: string, toolName: string): ApprovalRequest {
  return { id, toolName, capability: "write", summary: `${toolName} {}` };
}
function promptReturning(map: Record<string, ApprovalDecision>): (r: ApprovalRequest[]) => Promise<Map<string, ApprovalDecision>> {
  return async (reqs) => new Map(reqs.map((x) => [x.id, map[x.id] ?? "deny"]));
}

describe("SessionApprovalGate", () => {
  it("auto-approval tools never need approval", () => {
    const gate = new SessionApprovalGate(promptReturning({}), new Set(), async () => {});
    expect(gate.needsApproval(readTool)).toBe(false);
  });

  it("required tools need approval by default", () => {
    const gate = new SessionApprovalGate(promptReturning({}), new Set(), async () => {});
    expect(gate.needsApproval(writeTool)).toBe(true);
  });

  it("a tool in the always set does not need approval", () => {
    const gate = new SessionApprovalGate(promptReturning({}), new Set(["write_file"]), async () => {});
    expect(gate.needsApproval(writeTool)).toBe(false);
  });

  it("once approves only this batch (no persistence)", async () => {
    const gate = new SessionApprovalGate(promptReturning({ a: "once" }), new Set(), async () => {});
    const res = await gate.requestBatch([req("a", "write_file")]);
    expect(res.get("a")).toBe(true);
    expect(gate.needsApproval(writeTool)).toBe(true); // 下次仍需批准
  });

  it("session approves for the rest of the session", async () => {
    const gate = new SessionApprovalGate(promptReturning({ a: "session" }), new Set(), async () => {});
    await gate.requestBatch([req("a", "write_file")]);
    expect(gate.needsApproval(writeTool)).toBe(false);
  });

  it("always approves and persists", async () => {
    const persisted: string[] = [];
    const gate = new SessionApprovalGate(promptReturning({ a: "always" }), new Set(), async (n) => { persisted.push(n); });
    const res = await gate.requestBatch([req("a", "write_file")]);
    expect(res.get("a")).toBe(true);
    expect(persisted).toEqual(["write_file"]);
    expect(gate.needsApproval(writeTool)).toBe(false);
  });

  it("deny returns false and missing decisions default to deny", async () => {
    const gate = new SessionApprovalGate(promptReturning({ a: "deny" }), new Set(), async () => {});
    const res = await gate.requestBatch([req("a", "write_file"), req("b", "write_file")]);
    expect(res.get("a")).toBe(false);
    expect(res.get("b")).toBe(false);
  });
});
```

- [ ] **Step 2:** `npx vitest run src/approval/gate.test.ts` — FAIL(模块缺失)。

- [ ] **Step 3: 写 `src/approval/gate.ts`(EXACT)**
```ts
import type { Tool } from "../tools/types.js";
import type { ApprovalGate, ApprovalPrompt, ApprovalRequest } from "./types.js";

export class SessionApprovalGate implements ApprovalGate {
  private sessionApproved = new Set<string>();

  constructor(
    private prompt: ApprovalPrompt,
    private alwaysApproved: Set<string>,
    private persist: (toolName: string) => Promise<void>,
  ) {}

  needsApproval(tool: Tool): boolean {
    return (
      tool.approval !== "auto" &&
      !this.sessionApproved.has(tool.name) &&
      !this.alwaysApproved.has(tool.name)
    );
  }

  async requestBatch(requests: ApprovalRequest[]): Promise<Map<string, boolean>> {
    const decisions = await this.prompt(requests);
    const out = new Map<string, boolean>();
    for (const req of requests) {
      const d = decisions.get(req.id) ?? "deny";
      if (d === "session") this.sessionApproved.add(req.toolName);
      if (d === "always") {
        this.alwaysApproved.add(req.toolName);
        await this.persist(req.toolName);
      }
      out.set(req.id, d !== "deny");
    }
    return out;
  }
}
```

- [ ] **Step 4:** `npx vitest run src/approval/gate.test.ts` — 7 用例 PASS。
- [ ] **Step 5:** `npx tsc --noEmit` — clean。
- [ ] **Step 6:** 提交
```bash
git add src/approval/gate.ts src/approval/gate.test.ts
git commit -m "feat(approval): SessionApprovalGate with once/session/always"
```

---

## Task 5: write_file 工具

**Files:** Create `src/tools/write_file.ts`, Test `src/tools/write_file.test.ts`

**契约:** 参数 `{ path: string; content: string }`。`resolveInWorkspace` 解析;若目标**已存在**且 `ctx.readFiles` 提供但不含该绝对路径 → 抛"覆盖前需先 read_file";创建父目录后写入;写后把该路径加入 `readFiles`(写后即已知最新);返回 `已写入 <path>(<n> 行)`。capability "write",approval "required"。

- [ ] **Step 1: 失败测试 `src/tools/write_file.test.ts`(EXACT)**
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileTool } from "./write_file.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codeds-writefile-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("write_file tool", () => {
  it("creates a new file (no read required)", async () => {
    const out = await writeFileTool.handler(
      { path: "new.txt", content: "hello\nworld" },
      { workspaceRoot: root, readFiles: new Set() },
    );
    expect(out).toContain("已写入");
    expect(await fs.readFile(path.join(root, "new.txt"), "utf8")).toBe("hello\nworld");
  });

  it("creates parent directories as needed", async () => {
    await writeFileTool.handler(
      { path: "a/b/c.txt", content: "x" },
      { workspaceRoot: root, readFiles: new Set() },
    );
    expect(await fs.readFile(path.join(root, "a/b/c.txt"), "utf8")).toBe("x");
  });

  it("refuses to overwrite an existing file that was not read", async () => {
    await fs.writeFile(path.join(root, "exists.txt"), "old", "utf8");
    await expect(
      writeFileTool.handler({ path: "exists.txt", content: "new" }, { workspaceRoot: root, readFiles: new Set() }),
    ).rejects.toThrow(/先用 read_file/);
  });

  it("overwrites an existing file once it has been read", async () => {
    const abs = path.join(root, "exists.txt");
    await fs.writeFile(abs, "old", "utf8");
    await writeFileTool.handler(
      { path: "exists.txt", content: "new" },
      { workspaceRoot: root, readFiles: new Set([abs]) },
    );
    expect(await fs.readFile(abs, "utf8")).toBe("new");
  });

  it("rejects path escaping the workspace", async () => {
    await expect(
      writeFileTool.handler({ path: "../evil.txt", content: "x" }, { workspaceRoot: root, readFiles: new Set() }),
    ).rejects.toThrow(/越界/);
  });

  it("declares write capability and required approval", () => {
    expect(writeFileTool.capability).toBe("write");
    expect(writeFileTool.approval).toBe("required");
    expect(writeFileTool.name).toBe("write_file");
  });
});
```

- [ ] **Step 2:** `npx vitest run src/tools/write_file.test.ts` — FAIL(模块缺失)。

- [ ] **Step 3: 写 `src/tools/write_file.ts`(EXACT)**
```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "./types.js";
import { resolveInWorkspace } from "./paths.js";

export const writeFileTool = defineTool({
  name: "write_file",
  description: "在工作区内新建或整体重写一个文件。覆盖已存在文件前必须先用 read_file 读过它。",
  capability: "write",
  approval: "required",
  schema: z.object({
    path: z.string().describe("相对工作区根目录的文件路径"),
    content: z.string().describe("文件的完整内容"),
  }),
  handler: async (args, ctx) => {
    const abs = resolveInWorkspace(ctx.workspaceRoot, args.path);
    let exists = false;
    try {
      await fs.access(abs);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists && ctx.readFiles && !ctx.readFiles.has(abs)) {
      throw new Error(`覆盖已存在文件前请先用 read_file 读过它:${args.path}`);
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, args.content, "utf8");
    ctx.readFiles?.add(abs);
    return `已写入 ${args.path}(${args.content.split("\n").length} 行)`;
  },
});
```

- [ ] **Step 4:** `npx vitest run src/tools/write_file.test.ts` — 6 用例 PASS。
- [ ] **Step 5:** `npx tsc --noEmit` — clean。
- [ ] **Step 6:** 提交
```bash
git add src/tools/write_file.ts src/tools/write_file.test.ts
git commit -m "feat(tools): write_file with overwrite-requires-read guard"
```

---

## Task 6: edit_file 工具

**Files:** Create `src/tools/edit_file.ts`, Test `src/tools/edit_file.test.ts`

**契约:** 参数 `{ path; old_string; new_string; replace_all? }`。`resolveInWorkspace` 解析;若 `ctx.readFiles` 提供且不含该路径 → 抛"编辑前需先 read_file";读文件;`old_string` 出现 0 次 → 抛"未找到";>1 次且无 `replace_all` → 抛"不唯一";执行替换(`replace_all` 全替,否则替 1 处)后写回;返回 `已编辑 <path>(替换 N 处)`。capability "write",approval "required"。

- [ ] **Step 1: 失败测试 `src/tools/edit_file.test.ts`(EXACT)**
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { editFileTool } from "./edit_file.js";

let root: string;
let abs: string;
function ctx() {
  return { workspaceRoot: root, readFiles: new Set([abs]) };
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codeds-editfile-"));
  abs = path.join(root, "f.txt");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("edit_file tool", () => {
  it("replaces a unique occurrence", async () => {
    await fs.writeFile(abs, "alpha beta gamma", "utf8");
    const out = await editFileTool.handler({ path: "f.txt", old_string: "beta", new_string: "BETA" }, ctx());
    expect(out).toContain("替换 1 处");
    expect(await fs.readFile(abs, "utf8")).toBe("alpha BETA gamma");
  });

  it("replaces all occurrences when replace_all is set", async () => {
    await fs.writeFile(abs, "x x x", "utf8");
    const out = await editFileTool.handler(
      { path: "f.txt", old_string: "x", new_string: "y", replace_all: true },
      ctx(),
    );
    expect(out).toContain("替换 3 处");
    expect(await fs.readFile(abs, "utf8")).toBe("y y y");
  });

  it("throws when old_string is not found", async () => {
    await fs.writeFile(abs, "hello", "utf8");
    await expect(
      editFileTool.handler({ path: "f.txt", old_string: "nope", new_string: "x" }, ctx()),
    ).rejects.toThrow(/未找到/);
  });

  it("throws when old_string is not unique and replace_all is off", async () => {
    await fs.writeFile(abs, "x x", "utf8");
    await expect(
      editFileTool.handler({ path: "f.txt", old_string: "x", new_string: "y" }, ctx()),
    ).rejects.toThrow(/不唯一/);
  });

  it("requires the file to have been read", async () => {
    await fs.writeFile(abs, "hello", "utf8");
    await expect(
      editFileTool.handler(
        { path: "f.txt", old_string: "hello", new_string: "hi" },
        { workspaceRoot: root, readFiles: new Set() },
      ),
    ).rejects.toThrow(/先用 read_file/);
  });

  it("declares write capability and required approval", () => {
    expect(editFileTool.capability).toBe("write");
    expect(editFileTool.approval).toBe("required");
    expect(editFileTool.name).toBe("edit_file");
  });
});
```

- [ ] **Step 2:** `npx vitest run src/tools/edit_file.test.ts` — FAIL(模块缺失)。

- [ ] **Step 3: 写 `src/tools/edit_file.ts`(EXACT)**
```ts
import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool } from "./types.js";
import { resolveInWorkspace } from "./paths.js";

export const editFileTool = defineTool({
  name: "edit_file",
  description:
    "对工作区内已存在文件做精确字符串替换。old_string 必须在文件中唯一(否则用 replace_all 或扩大上下文)。编辑前需先用 read_file 读过它。",
  capability: "write",
  approval: "required",
  schema: z.object({
    path: z.string().describe("相对工作区根目录的文件路径"),
    old_string: z.string().describe("要被替换的原文(需唯一)"),
    new_string: z.string().describe("替换成的新文本"),
    replace_all: z.boolean().optional().describe("是否替换全部出现"),
  }),
  handler: async (args, ctx) => {
    const abs = resolveInWorkspace(ctx.workspaceRoot, args.path);
    if (ctx.readFiles && !ctx.readFiles.has(abs)) {
      throw new Error(`编辑前请先用 read_file 读过它:${args.path}`);
    }
    const raw = await fs.readFile(abs, "utf8");
    const count = raw.split(args.old_string).length - 1;
    if (count === 0) throw new Error(`未找到 old_string:${args.path}`);
    if (count > 1 && !args.replace_all) {
      throw new Error(`old_string 在 ${args.path} 出现 ${count} 次,不唯一;用 replace_all 或扩大上下文`);
    }
    const next = args.replace_all
      ? raw.split(args.old_string).join(args.new_string)
      : raw.replace(args.old_string, args.new_string);
    await fs.writeFile(abs, next, "utf8");
    return `已编辑 ${args.path}(替换 ${args.replace_all ? count : 1} 处)`;
  },
});
```

- [ ] **Step 4:** `npx vitest run src/tools/edit_file.test.ts` — 6 用例 PASS。
- [ ] **Step 5:** `npx tsc --noEmit` — clean。
- [ ] **Step 6:** 提交
```bash
git add src/tools/edit_file.ts src/tools/edit_file.test.ts
git commit -m "feat(tools): edit_file with unique-match and read guard"
```

---

## Task 7: 后台进程管理器

**Files:** Create `src/tools/process_manager.ts`, Test `src/tools/process_manager.test.ts`

**契约:** 模块级单例 `processManager`。
- `start(command, cwd): string` —— `spawn(command,{cwd,shell:true})`,分配 `proc-<n>` id,累积 stdout/stderr,监听 exit 置状态;返回 id。
- `poll(id): { status: "running"|"exited"; stdout; stderr; exitCode; signal }` —— 返回并**清空**已缓冲输出;未知 id 抛错。
- `kill(id): void` —— `SIGTERM`;未知 id 抛错。
- `reset(): void` —— 杀掉全部并清空(测试用)。

- [ ] **Step 1: 失败测试 `src/tools/process_manager.test.ts`(EXACT)**
```ts
import { describe, it, expect, afterEach } from "vitest";
import { processManager } from "./process_manager.js";

async function waitExited(id: string, timeoutMs = 3000) {
  const start = Date.now();
  // 轮询直到 exited(poll 会清空缓冲,故累积返回)
  let stdout = "";
  while (Date.now() - start < timeoutMs) {
    const r = processManager.poll(id);
    stdout += r.stdout;
    if (r.status === "exited") return { ...r, stdout };
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error("timed out waiting for exit");
}

afterEach(() => processManager.reset());

describe("processManager", () => {
  it("runs a background command and collects its output until exit", async () => {
    const id = processManager.start("echo bg-hello", process.cwd());
    expect(id).toMatch(/^proc-\d+$/);
    const r = await waitExited(id);
    expect(r.status).toBe("exited");
    expect(r.stdout).toContain("bg-hello");
    expect(r.exitCode).toBe(0);
  });

  it("drains buffered output on each poll", async () => {
    const id = processManager.start("echo one", process.cwd());
    await waitExited(id);
    const again = processManager.poll(id);
    expect(again.stdout).toBe(""); // 已被前次 poll 清空
  });

  it("kills a long-running process", async () => {
    const id = processManager.start("sleep 30", process.cwd());
    processManager.kill(id);
    const r = await waitExited(id);
    expect(r.status).toBe("exited");
  });

  it("throws on unknown id", () => {
    expect(() => processManager.poll("proc-999")).toThrow(/未知后台进程/);
    expect(() => processManager.kill("proc-999")).toThrow(/未知后台进程/);
  });
});
```

- [ ] **Step 2:** `npx vitest run src/tools/process_manager.test.ts` — FAIL(模块缺失)。

- [ ] **Step 3: 写 `src/tools/process_manager.ts`(EXACT)**
```ts
import { spawn, type ChildProcess } from "node:child_process";

interface BgProc {
  id: string;
  command: string;
  child: ChildProcess;
  stdout: string;
  stderr: string;
  status: "running" | "exited";
  exitCode: number | null;
  signal: string | null;
}

export interface PollResult {
  status: "running" | "exited";
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
}

class ProcessManager {
  private procs = new Map<string, BgProc>();
  private counter = 0;

  start(command: string, cwd: string): string {
    const id = `proc-${++this.counter}`;
    const child = spawn(command, { cwd, shell: true });
    const proc: BgProc = {
      id,
      command,
      child,
      stdout: "",
      stderr: "",
      status: "running",
      exitCode: null,
      signal: null,
    };
    child.stdout?.on("data", (d: Buffer) => {
      proc.stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      proc.stderr += d.toString();
    });
    child.on("exit", (code, signal) => {
      proc.status = "exited";
      proc.exitCode = code;
      proc.signal = signal;
    });
    this.procs.set(id, proc);
    return id;
  }

  poll(id: string): PollResult {
    const p = this.procs.get(id);
    if (!p) throw new Error(`未知后台进程:${id}`);
    const out: PollResult = {
      status: p.status,
      stdout: p.stdout,
      stderr: p.stderr,
      exitCode: p.exitCode,
      signal: p.signal,
    };
    p.stdout = "";
    p.stderr = "";
    return out;
  }

  kill(id: string): void {
    const p = this.procs.get(id);
    if (!p) throw new Error(`未知后台进程:${id}`);
    p.child.kill("SIGTERM");
  }

  reset(): void {
    for (const p of this.procs.values()) p.child.kill("SIGKILL");
    this.procs.clear();
    this.counter = 0;
  }
}

export const processManager = new ProcessManager();
```

- [ ] **Step 4:** `npx vitest run src/tools/process_manager.test.ts` — 4 用例 PASS。
- [ ] **Step 5:** `npx tsc --noEmit` — clean。
- [ ] **Step 6:** 提交
```bash
git add src/tools/process_manager.ts src/tools/process_manager.test.ts
git commit -m "feat(tools): background process manager (spawn/poll/kill)"
```

---

## Task 8: exec_shell 工具(前台 + 后台)

**Files:** Create `src/tools/exec_shell.ts`, Test `src/tools/exec_shell.test.ts`

**契约:** 参数 `{ command: string; background?: boolean; timeout?: number }`。
- `background` → `processManager.start(command, workspaceRoot)`,立即返回 `已在后台启动(id=<id>)...`。
- 否则前台 `exec`(cwd=workspaceRoot,timeout 默认 120000,maxBuffer 10MB),**非零退出不抛**,返回拼好的 stdout/stderr + `[exit N]`/`[超时,已终止]`。
capability "exec",approval "required"。

- [ ] **Step 1: 失败测试 `src/tools/exec_shell.test.ts`(EXACT)**
```ts
import { describe, it, expect, afterEach } from "vitest";
import { execShellTool } from "./exec_shell.js";
import { processManager } from "./process_manager.js";

afterEach(() => processManager.reset());
const ctx = { workspaceRoot: process.cwd() };

describe("exec_shell tool", () => {
  it("runs a foreground command and returns stdout + exit code", async () => {
    const out = await execShellTool.handler({ command: "echo fg-hello" }, ctx);
    expect(out).toContain("fg-hello");
    expect(out).toContain("[exit 0]");
  });

  it("reports a non-zero exit code without throwing", async () => {
    const out = await execShellTool.handler({ command: "sh -c 'exit 3'" }, ctx);
    expect(out).toContain("[exit 3]");
  });

  it("starts a background process and returns its id", async () => {
    const out = await execShellTool.handler({ command: "echo bg", background: true }, ctx);
    expect(out).toMatch(/id=proc-\d+/);
  });

  it("declares exec capability and required approval", () => {
    expect(execShellTool.capability).toBe("exec");
    expect(execShellTool.approval).toBe("required");
    expect(execShellTool.name).toBe("exec_shell");
  });
});
```

- [ ] **Step 2:** `npx vitest run src/tools/exec_shell.test.ts` — FAIL(模块缺失)。

- [ ] **Step 3: 写 `src/tools/exec_shell.ts`(EXACT)**
```ts
import { exec } from "node:child_process";
import { z } from "zod";
import { defineTool } from "./types.js";
import { processManager } from "./process_manager.js";

interface ForegroundResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

function runForeground(command: string, cwd: string, timeout: number): Promise<ForegroundResult> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout, maxBuffer: 10 * 1024 * 1024 }, (err: any, stdout, stderr) => {
      const timedOut = Boolean(err?.killed) && err?.signal === "SIGTERM";
      const code = typeof err?.code === "number" ? err.code : err ? 1 : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), code, timedOut });
    });
  });
}

export const execShellTool = defineTool({
  name: "exec_shell",
  description:
    "在工作区目录执行 shell 命令(git、测试、find 等都走它)。前台执行返回输出与退出码;background=true 则后台启动并返回进程 id(用 exec_shell_poll 读输出、exec_shell_kill 结束)。",
  capability: "exec",
  approval: "required",
  schema: z.object({
    command: z.string().describe("要执行的 shell 命令"),
    background: z.boolean().optional().describe("是否后台运行(长任务/服务)"),
    timeout: z.number().int().min(1).optional().describe("前台超时(毫秒),默认 120000"),
  }),
  handler: async (args, ctx) => {
    if (args.background) {
      const id = processManager.start(args.command, ctx.workspaceRoot);
      return `已在后台启动(id=${id})。用 exec_shell_poll 读取输出,exec_shell_kill 结束。`;
    }
    const r = await runForeground(args.command, ctx.workspaceRoot, args.timeout ?? 120000);
    const parts: string[] = [];
    if (r.stdout.trim()) parts.push(r.stdout.trimEnd());
    if (r.stderr.trim()) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
    parts.push(r.timedOut ? `[超时,已终止]` : `[exit ${r.code}]`);
    return parts.join("\n");
  },
});
```

- [ ] **Step 4:** `npx vitest run src/tools/exec_shell.test.ts` — 4 用例 PASS。
- [ ] **Step 5:** `npx tsc --noEmit` — clean。
- [ ] **Step 6:** 提交
```bash
git add src/tools/exec_shell.ts src/tools/exec_shell.test.ts
git commit -m "feat(tools): exec_shell foreground + background"
```

---

## Task 9: exec_shell_poll + exec_shell_kill 工具

**Files:** Create `src/tools/exec_shell_poll.ts`, `src/tools/exec_shell_kill.ts`, Test `src/tools/exec_shell_ctl.test.ts`

**契约:** 二者参数均 `{ id: string }`,操作已启动的后台进程(已批准),故 approval "auto"。
- `exec_shell_poll`(capability "read"):返回 `状态:<status>` + 已缓冲输出 +(退出时)`[exit N ...]`。
- `exec_shell_kill`(capability "exec"):发 SIGTERM,返回确认。

- [ ] **Step 1: 失败测试 `src/tools/exec_shell_ctl.test.ts`(EXACT)**
```ts
import { describe, it, expect, afterEach } from "vitest";
import { execShellPollTool } from "./exec_shell_poll.js";
import { execShellKillTool } from "./exec_shell_kill.js";
import { processManager } from "./process_manager.js";

afterEach(() => processManager.reset());
const ctx = { workspaceRoot: process.cwd() };

async function waitFor(pred: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("exec_shell_poll / exec_shell_kill", () => {
  it("polls a background process's output and status", async () => {
    const id = processManager.start("echo polled", process.cwd());
    let out = "";
    await waitFor(() => {
      const r = processManager.poll(id);
      out += r.stdout;
      // 把读到的塞回去会清空,这里只是等到 exited
      return r.status === "exited";
    });
    // 进程已退出;再起一个新的来测 poll 工具本身的格式
    const id2 = processManager.start("echo via-tool", process.cwd());
    await new Promise((r) => setTimeout(r, 200));
    const formatted = await execShellPollTool.handler({ id: id2 }, ctx);
    expect(formatted).toContain("状态:");
  });

  it("kills a background process via the tool", async () => {
    const id = processManager.start("sleep 30", process.cwd());
    const out = await execShellKillTool.handler({ id }, ctx);
    expect(out).toContain(id);
    await waitFor(() => processManager.poll(id).status === "exited");
    expect(processManager.poll(id).status).toBe("exited");
  });

  it("declares auto approval", () => {
    expect(execShellPollTool.approval).toBe("auto");
    expect(execShellKillTool.approval).toBe("auto");
    expect(execShellPollTool.name).toBe("exec_shell_poll");
    expect(execShellKillTool.name).toBe("exec_shell_kill");
  });
});
```

- [ ] **Step 2:** `npx vitest run src/tools/exec_shell_ctl.test.ts` — FAIL(模块缺失)。

- [ ] **Step 3: 写 `src/tools/exec_shell_poll.ts`(EXACT)**
```ts
import { z } from "zod";
import { defineTool } from "./types.js";
import { processManager } from "./process_manager.js";

export const execShellPollTool = defineTool({
  name: "exec_shell_poll",
  description: "读取某个后台进程自上次轮询以来的新输出与当前状态(running/exited)。",
  capability: "read",
  approval: "auto",
  schema: z.object({
    id: z.string().describe("exec_shell 返回的后台进程 id"),
  }),
  handler: async (args) => {
    const r = processManager.poll(args.id);
    const parts: string[] = [`状态:${r.status}`];
    if (r.stdout.trim()) parts.push(r.stdout.trimEnd());
    if (r.stderr.trim()) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
    if (r.status === "exited") {
      parts.push(`[exit ${r.exitCode ?? ""}${r.signal ? ` signal ${r.signal}` : ""}]`);
    }
    return parts.join("\n");
  },
});
```

- [ ] **Step 4: 写 `src/tools/exec_shell_kill.ts`(EXACT)**
```ts
import { z } from "zod";
import { defineTool } from "./types.js";
import { processManager } from "./process_manager.js";

export const execShellKillTool = defineTool({
  name: "exec_shell_kill",
  description: "终止某个后台进程(发送 SIGTERM)。",
  capability: "exec",
  approval: "auto",
  schema: z.object({
    id: z.string().describe("exec_shell 返回的后台进程 id"),
  }),
  handler: async (args) => {
    processManager.kill(args.id);
    return `已发送终止信号给 ${args.id}`;
  },
});
```

- [ ] **Step 5:** `npx vitest run src/tools/exec_shell_ctl.test.ts` — 3 用例 PASS。
- [ ] **Step 6:** `npx tsc --noEmit` — clean。
- [ ] **Step 7:** 提交
```bash
git add src/tools/exec_shell_poll.ts src/tools/exec_shell_kill.ts src/tools/exec_shell_ctl.test.ts
git commit -m "feat(tools): exec_shell_poll and exec_shell_kill"
```

---

## Task 10: 审批感知执行器

**Files:** Rewrite `src/tools/execute.ts`, Rewrite `src/tools/execute.test.ts`

**契约:** `executeToolCalls(toolCalls, registry: ToolRegistry, ctx, gate: ApprovalGate): Promise<ToolMessage[]>`。
- 分类:对每个 tool_call,取 `registry.get(name)`;若工具存在且 `gate.needsApproval(tool)` → gated;否则(auto 工具 / 未知工具)→ 立即派发。
- **auto 立即并发**:在请求审批**之前**就启动 auto 派发(不被审批阻塞)。
- gated 合并成**一次** `gate.requestBatch(requests)`;批准的并发派发,被拒的返回 `用户拒绝执行该工具。`。
- 结果按 `toolCalls` 原顺序返回。派发失败仍隔离成 `Error: ...`。

- [ ] **Step 1: 整体重写测试 `src/tools/execute.test.ts`(EXACT)**
```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { executeToolCalls } from "./execute.js";
import { ToolRegistry } from "./registry.js";
import { defineTool } from "./types.js";
import type { ToolCall } from "../client/types.js";
import type { ApprovalGate, ApprovalRequest } from "../approval/types.js";
import type { Tool } from "./types.js";

const ctx = { workspaceRoot: "/tmp" };

function call(id: string, name: string, args = "{}"): ToolCall {
  return { id, type: "function", function: { name, arguments: args } };
}

function reg() {
  const r = new ToolRegistry();
  r.register(
    defineTool({
      name: "read_file", description: "", capability: "read", approval: "auto",
      schema: z.object({}), handler: async () => "READ",
    }),
  );
  r.register(
    defineTool({
      name: "write_file", description: "", capability: "write", approval: "required",
      schema: z.object({}), handler: async () => "WROTE",
    }),
  );
  return r;
}

// 一个按工具默认审批级判定、对所有 gated 请求统一给定决定的门(并记录是否被调用)。
function gateWith(approve: boolean) {
  const calls: ApprovalRequest[][] = [];
  const gate: ApprovalGate = {
    needsApproval: (tool: Tool) => tool.approval !== "auto",
    requestBatch: async (requests) => {
      calls.push(requests);
      return new Map(requests.map((r) => [r.id, approve]));
    },
  };
  return { gate, calls };
}

describe("executeToolCalls (approval-aware)", () => {
  it("runs auto tools without asking for approval", async () => {
    const { gate, calls } = gateWith(false);
    const out = await executeToolCalls([call("a", "read_file")], reg(), ctx, gate);
    expect(out).toEqual([{ role: "tool", tool_call_id: "a", content: "READ" }]);
    expect(calls).toHaveLength(0); // 未请求审批
  });

  it("executes a gated tool once approved", async () => {
    const { gate, calls } = gateWith(true);
    const out = await executeToolCalls([call("a", "write_file")], reg(), ctx, gate);
    expect(out).toEqual([{ role: "tool", tool_call_id: "a", content: "WROTE" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]!.toolName).toBe("write_file");
  });

  it("returns a rejection message when a gated tool is denied", async () => {
    const { gate } = gateWith(false);
    const out = await executeToolCalls([call("a", "write_file")], reg(), ctx, gate);
    expect(out[0]!.content).toContain("用户拒绝");
  });

  it("asks approval for gated tools in a single batch and keeps order", async () => {
    const { gate, calls } = gateWith(true);
    const out = await executeToolCalls(
      [call("a", "read_file"), call("b", "write_file"), call("c", "write_file")],
      reg(),
      ctx,
      gate,
    );
    expect(out.map((m) => m.tool_call_id)).toEqual(["a", "b", "c"]);
    expect(calls).toHaveLength(1); // 一次合并提示
    expect(calls[0]!.map((r) => r.id)).toEqual(["b", "c"]); // 只含 gated
  });

  it("isolates a dispatch error as an Error message", async () => {
    const r = new ToolRegistry();
    r.register(
      defineTool({
        name: "read_file", description: "", capability: "read", approval: "auto",
        schema: z.object({}), handler: async () => { throw new Error("boom"); },
      }),
    );
    const { gate } = gateWith(false);
    const out = await executeToolCalls([call("a", "read_file")], r, ctx, gate);
    expect(out[0]!.content).toBe("Error: boom");
  });
});
```

- [ ] **Step 2:** `npx vitest run src/tools/execute.test.ts` — FAIL(签名/行为变更)。

- [ ] **Step 3: 整体重写 `src/tools/execute.ts`(EXACT)**
```ts
import type { ToolCall, ToolMessage } from "../client/types.js";
import type { ToolContext } from "./types.js";
import type { ToolRegistry } from "./registry.js";
import type { ApprovalGate, ApprovalRequest } from "../approval/types.js";

async function dispatchOne(
  tc: ToolCall,
  registry: ToolRegistry,
  ctx: ToolContext,
): Promise<ToolMessage> {
  try {
    const content = await registry.dispatch(tc.function.name, tc.function.arguments, ctx);
    return { role: "tool", tool_call_id: tc.id, content };
  } catch (err) {
    return { role: "tool", tool_call_id: tc.id, content: `Error: ${(err as Error).message}` };
  }
}

// 审批感知地执行一批 tool_call:
// - auto / 未知工具立即并发派发(不被审批阻塞)
// - 需审批的工具合并成一次提示,批准的并发派发、被拒返回拒绝消息
// - 结果按原顺序返回
export async function executeToolCalls(
  toolCalls: ToolCall[],
  registry: ToolRegistry,
  ctx: ToolContext,
  gate: ApprovalGate,
): Promise<ToolMessage[]> {
  // 1. 分类
  const gatedRequests: ApprovalRequest[] = [];
  for (const tc of toolCalls) {
    const tool = registry.get(tc.function.name);
    if (tool && gate.needsApproval(tool)) {
      gatedRequests.push({
        id: tc.id,
        toolName: tc.function.name,
        capability: tool.capability,
        summary: `${tc.function.name} ${tc.function.arguments}`,
      });
    }
  }
  const gatedIds = new Set(gatedRequests.map((r) => r.id));

  // 2. auto 立即并发启动(在审批提示之前)
  const started = new Map<string, Promise<ToolMessage>>();
  for (const tc of toolCalls) {
    if (!gatedIds.has(tc.id)) started.set(tc.id, dispatchOne(tc, registry, ctx));
  }

  // 3. 合并请求 gated 工具的审批
  const approvals =
    gatedRequests.length > 0 ? await gate.requestBatch(gatedRequests) : new Map<string, boolean>();

  // 4. 批准的 gated 并发派发,被拒返回拒绝消息
  for (const tc of toolCalls) {
    if (!gatedIds.has(tc.id)) continue;
    if (approvals.get(tc.id)) {
      started.set(tc.id, dispatchOne(tc, registry, ctx));
    } else {
      started.set(
        tc.id,
        Promise.resolve<ToolMessage>({
          role: "tool",
          tool_call_id: tc.id,
          content: "用户拒绝执行该工具。",
        }),
      );
    }
  }

  // 5. 按原顺序收集
  return Promise.all(toolCalls.map((tc) => started.get(tc.id)!));
}
```

- [ ] **Step 4:** `npx vitest run src/tools/execute.test.ts` — 5 用例 PASS。
- [ ] **Step 5:** `npx tsc --noEmit`。
Expected:会报错——`src/agent/loop.ts`(M2)仍按旧 4 参签名调用且 `AgentDeps.executeToolCalls` 类型不符。**预期**,Task 11 修。确认错误只在 loop.ts。
- [ ] **Step 6:** 提交
```bash
git add src/tools/execute.ts src/tools/execute.test.ts
git commit -m "feat(tools): approval-aware concurrent executor"
```

---

## Task 11: 把 gate 穿透进 turn loop

**Files:** Modify `src/agent/loop.ts`, `src/agent/loop.test.ts`

- [ ] **Step 1: 改 `src/agent/loop.ts`** ——
  1) 顶部 import 增加:`import type { ApprovalGate } from "../approval/types.js";`,并把 `ToolDispatcher` 的 import 去掉(改用 registry 直传)。
  2) `AgentDeps` 增加字段 `gate: ApprovalGate;`,并把 `executeToolCalls` 的类型改为:
```ts
  executeToolCalls: (
    toolCalls: ToolCall[],
    registry: ToolRegistry,
    ctx: ToolContext,
    gate: ApprovalGate,
  ) => Promise<ToolMessage[]>;
```
  3) 把循环里的调用改为:
```ts
    const toolMessages = await deps.executeToolCalls(
      assistant.tool_calls,
      deps.registry,
      deps.ctx,
      deps.gate,
    );
```
  (其余 renderTurn / 结构不变。`import type { ToolRegistry }` 已存在;若移除了 `ToolDispatcher` import 注意它不再被引用。)

- [ ] **Step 2: 改 `src/agent/loop.test.ts`** —— 顶部加一个 stub gate,并给**每个** `runAgent({...})` 调用补 `gate: stubGate,`:
```ts
import type { ApprovalGate } from "../approval/types.js";
const stubGate: ApprovalGate = { needsApproval: () => false, requestBatch: async () => new Map() };
```
(共 5 处 runAgent 调用,每处 deps 里加 `gate: stubGate,`。fake `executeToolCalls` 忽略新参,无需改签名。)

- [ ] **Step 3:** `npx vitest run src/agent/loop.test.ts` — 5 用例仍 PASS。
- [ ] **Step 4:** `npx tsc --noEmit`。
Expected:loop.ts 错误消失;此刻应只剩 `src/index.ts`(M2 版仍按旧 executeToolCalls/无 gate 调用)报错——Task 13 修。确认错误只在 index.ts。
- [ ] **Step 5:** 提交
```bash
git add src/agent/loop.ts src/agent/loop.test.ts
git commit -m "feat(agent): thread approval gate through the turn loop"
```

---

## Task 12: 命令行审批提示

**Files:** Create `src/approval/stdin_prompt.ts`(readline 实现;不做单测,Task 14 真跑验证)

- [ ] **Step 1: 写 `src/approval/stdin_prompt.ts`(EXACT)**
```ts
import { createInterface } from "node:readline/promises";
import type { ApprovalDecision, ApprovalRequest } from "./types.js";

// 命令行审批提示:逐个请求问 y/s/a/n,返回每个 id 的决定。
// y=本次  s=本会话  a=永久(写入配置)  其它=拒绝
export async function stdinApprovalPrompt(
  requests: ApprovalRequest[],
): Promise<Map<string, ApprovalDecision>> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const out = new Map<string, ApprovalDecision>();
  try {
    for (const req of requests) {
      process.stdout.write(
        `\n需要批准:${req.summary}\n  [y]本次  [s]本会话  [a]永久  [n]拒绝 > `,
      );
      const ans = (await rl.question("")).trim().toLowerCase();
      const decision: ApprovalDecision =
        ans === "y" ? "once" : ans === "s" ? "session" : ans === "a" ? "always" : "deny";
      out.set(req.id, decision);
    }
  } finally {
    rl.close();
  }
  return out;
}
```

- [ ] **Step 2:** `npx tsc --noEmit`(确认本文件类型正确;index 仍报错待 Task 13)。
- [ ] **Step 3:** 提交
```bash
git add src/approval/stdin_prompt.ts
git commit -m "feat(approval): readline-based approval prompt"
```

---

## Task 13: 装配 index + 全量验收

**Files:** Rewrite `src/index.ts`

- [ ] **Step 1: 整体重写 `src/index.ts`(EXACT)**
```ts
import path from "node:path";
import { loadConfig } from "./config/config.js";
import { streamChat } from "./client/client.js";
import { runAgent } from "./agent/loop.js";
import { executeToolCalls } from "./tools/execute.js";
import { ToolRegistry } from "./tools/registry.js";
import { readFileTool } from "./tools/read_file.js";
import { listDirTool } from "./tools/list_dir.js";
import { writeFileTool } from "./tools/write_file.js";
import { editFileTool } from "./tools/edit_file.js";
import { execShellTool } from "./tools/exec_shell.js";
import { execShellPollTool } from "./tools/exec_shell_poll.js";
import { execShellKillTool } from "./tools/exec_shell_kill.js";
import { SessionApprovalGate } from "./approval/gate.js";
import { stdinApprovalPrompt } from "./approval/stdin_prompt.js";
import { loadAlwaysApproved, appendAlwaysApproved } from "./approval/store.js";

async function main() {
  const prompt = process.argv.slice(2).join(" ").trim();
  if (!prompt) {
    console.error('用法: npm run dev -- "你的问题"');
    process.exit(1);
  }

  let cfg;
  try {
    cfg = loadConfig(process.env);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const workspaceRoot = process.cwd();
  const approvalsFile = path.join(workspaceRoot, ".codeds", "approvals.json");

  const registry = new ToolRegistry();
  registry.register(readFileTool);
  registry.register(listDirTool);
  registry.register(writeFileTool);
  registry.register(editFileTool);
  registry.register(execShellTool);
  registry.register(execShellPollTool);
  registry.register(execShellKillTool);

  const alwaysApproved = await loadAlwaysApproved(approvalsFile);
  const gate = new SessionApprovalGate(stdinApprovalPrompt, alwaysApproved, (name) =>
    appendAlwaysApproved(approvalsFile, name),
  );

  await runAgent({
    prompt,
    config: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model },
    registry,
    ctx: { workspaceRoot, readFiles: new Set<string>() },
    gate,
    streamChat,
    executeToolCalls,
    write: (s) => process.stdout.write(s),
  });
}

main().catch((err) => {
  console.error("\n" + (err as Error).message);
  process.exit(1);
});
```

- [ ] **Step 2: 全量 typecheck** —— `npx tsc --noEmit`。Expected:**退出码 0,零错误**(所有重构收口)。
- [ ] **Step 3: 全量测试** —— `npx vitest run`。Expected:全 PASS。预期新增/改动文件:paths(5)、approval/store(3)、approval/gate(7)、write_file(6)、edit_file(6)、process_manager(4)、exec_shell(4)、exec_shell_ctl(3)、execute(5,改写)、read_file(6)、list_dir(5);加上未变的 config(3)、sse(6)、client(5)、schema(1)、registry(5)、loop(5)。报实际总数。
- [ ] **Step 4: 无网络冒烟** ——
  `DEEPSEEK_API_KEY= npm run dev -- "hi"` → 含 "Missing DEEPSEEK_API_KEY",退出 1。
  `DEEPSEEK_API_KEY=x npm run dev` → 用法行,退出 1。
- [ ] **Step 5:** 提交
```bash
git add src/index.ts
git commit -m "feat: wire approval gate and write/exec tools into CLI"
```

---

## Task 14: 真网络验收(审批门 + 写/执行 + PathEscape)

> 需有效 key,会触网+计费。key 在用户本机 `.env` 的 `DS_API_KEY`,运行时桥接为 `DEEPSEEK_API_KEY`,不读取/不回显 key。审批通过管道喂入(`y`=本次)。**由 controller 执行。**

- [ ] **Step 1: 写文件 + 审批通过** ——
```bash
set -a && . ./.env && set +a && printf 'y\n' | DEEPSEEK_API_KEY="$DS_API_KEY" npm run dev -- "在当前目录创建文件 m3-smoke.txt,内容写一行 hello-m3" 2>&1
```
Expected:出现 `→ write_file`,接着审批提示 `需要批准:write_file ...`,喂入的 `y` 放行,工具执行,模型确认。退出 0。然后验证:`cat m3-smoke.txt` 应为 `hello-m3`(随后删除该文件保持干净)。

- [ ] **Step 2: 执行命令** ——
```bash
set -a && . ./.env && set +a && printf 'y\n' | DEEPSEEK_API_KEY="$DS_API_KEY" npm run dev -- "用 exec_shell 跑 node --version 并告诉我版本" 2>&1
```
Expected:`→ exec_shell` + 审批 + `y` 放行 + 输出 node 版本 + 模型作答,退出 0。

- [ ] **Step 3: 拒绝路径** ——
```bash
set -a && . ./.env && set +a && printf 'n\n' | DEEPSEEK_API_KEY="$DS_API_KEY" npm run dev -- "把 m3-smoke.txt 删掉" 2>&1
```
Expected:审批提示后喂 `n`,工具返回"用户拒绝执行该工具。",模型据此说明未执行。退出 0。

- [ ] **Step 4: 记录结论** —— 把 M3 验收结果(审批 once/session/always 是否生效、PathEscape 是否拦截、后台 poll/kill 是否可用)用一句话追加到设计文档 §5 末尾(如"M3 已落地并实测:...")。提交:
```bash
git add docs/architecture/overview.md
git commit -m "docs: record M3 approval + write/exec acceptance"
```

---

## 验收标准(M3 完成的定义)

- [ ] `npx vitest run` 全绿(约 79 用例,见 Task 13 Step 3)。
- [ ] `npx tsc --noEmit` 零错。
- [ ] 缺 key / 无参数冒烟报错并退出 1。
- [ ] PathEscape:`..`/绝对路径越界被四个文件工具拒绝(有测试)。
- [ ] 审批门:auto 工具不提示;write/exec 工具提示;once/session/always 行为正确(有测试);被拒返回拒绝消息;auto 工具在审批期间不被阻塞。
- [ ] always 放行写入 `.codeds/approvals.json` 并在下次启动加载(有测试)。
- [ ] 写工具"覆盖/编辑前需已读"守卫生效(有测试)。
- [ ] 后台进程:exec_shell background + poll + kill 闭环(有测试)。
- [ ] 真网络:批准→执行、拒绝→不执行、命令执行均验证(Task 14)。

## 给后续里程碑留的接口/carry-over

- **细粒度策略**(后续):exec 命令级 allowlist/denylist、网络域名 policy、sandbox-policy —— 审批门当前是"整体需审批",可在 `needsApproval`/`requestBatch` 前插入策略层。
- **plan 模式**(M5):据 mode 禁用 write/exec 类工具(capability ∈ {write,exec})——`ctx` 或 gate 之后带 mode。
- **审批摘要**(carry-over):`ApprovalRequest.summary` 现为原始 JSON 参数;可给 Tool 加 `preview(args)` 生成更友好的摘要(如 write_file 显示路径+行数、exec_shell 显示命令)。
- **always 的项目/用户级**(设计 §7):当前持久化在项目级 `.codeds/approvals.json`;用户级合并留待记忆/配置体系统一。
- **M2 遗留 cosmetic**(M9):tool_call announce 用首片名字(执行不受影响)。
- **后台进程清理**:进程随 codeds 退出而留存于 OS;长期可加退出时统一 kill(M9/收尾)。
