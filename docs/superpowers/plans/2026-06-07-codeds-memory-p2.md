# 记忆 P2 实现计划(用户模型 + 读时权威验证 + 会话结束蒸馏)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development(推荐)或 superpowers:executing-plans 逐任务实现。步骤用 `- [ ]` 勾选框。

**Goal:** 把 codeds 记忆从"JSON 事实数组 + 启动全量注入"升级为"md+frontmatter 数据单元 + 用户模型蒸馏 + 读时确定性权威验证 + 写入去重/作废不删",做出"越用越懂你"的差异化,且**稳态每回合 0 额外 LLM 调用**。

**Architecture:** 数据单元 = 一事一文件 `.codeds/memory/<name>.md`(YAML frontmatter + 正文)。读路径在**会话启动一次性**完成:加载 → 确定性权威验证(代码事实对照 live code 的 hash)→ 注入固定前缀(保 §10 prefix cache)。写路径:热路径 `memory_write` + **会话结束蒸馏**(独立一次 flash + 关思考 + 温度0 调用,抽取原子事实/用户模型更新)→ 相似度分带去重 + 矛盾作废不删。成本纪律:打分/验证/去重全确定性,LLM 只用于蒸馏。

**Tech Stack:** Node20+/TS-ESM/vitest/tsx,**零新依赖**(自写极简 frontmatter 解析,复用现有 `streamChat`/`resolveInWorkspace`)。

**范围**:本期做数据模型迁移、读时验证、`memory_write` 升级、会话结束蒸馏(含去重/作废)。**不做(留 P3)**:embedding 检索 + 衰减 GC、失败反思→规则、多信号 relevance 排序(本期小规模仍全量注入已验证集)。

**向后兼容**:存在旧 `memories.json` 时,启动时一次性迁移成 md 文件(每条 text → 一个 `type: semantic` 文件),迁移后重命名旧文件为 `.migrated`。

---

## 数据模型与文件结构

- `src/memory/types.ts` — 扩展 `Memory` 接口 + `MemoryType`。
- `src/memory/frontmatter.ts`(新)— 极简 frontmatter 解析/序列化(零依赖)。
- `src/memory/store.ts` — 改为读写 md 文件目录;加载、写入(去重/作废)、迁移。
- `src/memory/validate.ts`(新)— 读时确定性权威验证。
- `src/memory/distill.ts`(新)— 会话结束蒸馏(纯函数:给定 streamChat + 对话 → 候选记忆)。
- `src/tools/memory_write.ts` — 升级参数(type/importance/source/confidence)。
- `src/index.ts` — 启动:迁移 + 加载 + 验证 + 注入;退出:触发蒸馏。
- `src/memory/hash.ts`(新)— 稳定内容 hash(复用 node:crypto)。

---

## Task 1: 扩展 Memory 数据模型

**Files:**
- Modify: `src/memory/types.ts`
- Test: `src/memory/types.test.ts`(新,仅类型/默认值守卫)

- [ ] **Step 1: 写失败测试**

```ts
// src/memory/types.test.ts
import { describe, it, expect } from "vitest";
import { newMemory } from "./types.js";

describe("newMemory", () => {
  it("fills defaults", () => {
    const m = newMemory({ name: "uses-pnpm", text: "用 pnpm", type: "semantic", today: "2026-06-07" });
    expect(m).toMatchObject({
      name: "uses-pnpm", text: "用 pnpm", type: "semantic",
      importance: 5, status: "active", created: "2026-06-07", lastUsed: "2026-06-07",
    });
    expect(m.locked).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/memory/types.test.ts`
Expected: FAIL（`newMemory` 未定义）

- [ ] **Step 3: 实现**

```ts
// src/memory/types.ts
export type MemoryScope = "project" | "user";
export type MemoryType = "user" | "semantic" | "procedural" | "episodic";

export interface Memory {
  name: string;              // slug = 文件名(不含 .md)
  text: string;              // 正文:一句话事实/规则
  type: MemoryType;
  importance: number;        // 1–10
  confidence?: number;       // 0–1,用户模型/推断类用
  created: string;           // ISO date
  lastUsed: string;
  source?: string;           // "path" 或 "path#symbol"(仅从代码推导的事实)
  sourceHash?: string;       // 写入时 source 内容的 hash
  status: "active" | "superseded";
  supersededBy?: string;
  validUntil?: string;
  locked?: boolean;
}

export function newMemory(p: {
  name: string; text: string; type: MemoryType; today: string;
  importance?: number; confidence?: number; source?: string; sourceHash?: string;
}): Memory {
  return {
    name: p.name, text: p.text.trim(), type: p.type,
    importance: p.importance ?? 5,
    ...(p.confidence !== undefined ? { confidence: p.confidence } : {}),
    created: p.today, lastUsed: p.today,
    ...(p.source ? { source: p.source } : {}),
    ...(p.sourceHash ? { sourceHash: p.sourceHash } : {}),
    status: "active", locked: false,
  };
}
```

- [ ] **Step 4: 跑测试确认通过** — Run: `npx vitest run src/memory/types.test.ts` → PASS
- [ ] **Step 5: 提交** — `git add -A && git commit -m "feat(memory): extend Memory model with type/importance/source/status"`

---

## Task 2: 极简 frontmatter 解析/序列化(零依赖)

**Files:**
- Create: `src/memory/frontmatter.ts`
- Test: `src/memory/frontmatter.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/memory/frontmatter.test.ts
import { describe, it, expect } from "vitest";
import { parseMemoryFile, serializeMemory } from "./frontmatter.js";
import { newMemory } from "./types.js";

describe("frontmatter round-trip", () => {
  it("serializes then parses back equal", () => {
    const m = newMemory({ name: "x", text: "用 pnpm 安装", type: "procedural", today: "2026-06-07", importance: 7, source: "package.json#packageManager", sourceHash: "abc" });
    const text = serializeMemory(m);
    expect(text).toMatch(/^---\n/);
    expect(parseMemoryFile("x", text)).toEqual(m);
  });
  it("tolerates missing optional fields", () => {
    const raw = "---\nname: y\ntype: user\nimportance: 3\ncreated: 2026-06-01\nlastUsed: 2026-06-02\nstatus: active\n---\n用户偏好 TypeScript\n";
    const m = parseMemoryFile("y", raw);
    expect(m?.type).toBe("user");
    expect(m?.text).toBe("用户偏好 TypeScript");
    expect(m?.source).toBeUndefined();
  });
  it("returns null on garbage", () => {
    expect(parseMemoryFile("z", "no frontmatter here")).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — Run: `npx vitest run src/memory/frontmatter.test.ts` → FAIL

- [ ] **Step 3: 实现**(只支持标量 key: value + 正文;数组/嵌套不需要)

```ts
// src/memory/frontmatter.ts
import type { Memory, MemoryType } from "./types.js";

const STR = new Set(["name", "text", "type", "created", "lastUsed", "source", "sourceHash", "status", "supersededBy", "validUntil"]);
const NUM = new Set(["importance", "confidence"]);
const BOOL = new Set(["locked"]);

// 解析一个记忆 md 文件;name 由文件名传入(frontmatter 的 name 优先)。失败返回 null。
export function parseMemoryFile(name: string, raw: string): Memory | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const [, fm, body] = m;
  const obj: Record<string, unknown> = {};
  for (const line of fm.split("\n")) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (NUM.has(k)) obj[k] = Number(v);
    else if (BOOL.has(k)) obj[k] = v === "true";
    else if (STR.has(k)) obj[k] = v;
  }
  if (!obj.type || !obj.status) return null;
  return {
    name: (obj.name as string) || name,
    text: body.trim(),
    type: obj.type as MemoryType,
    importance: typeof obj.importance === "number" && !Number.isNaN(obj.importance) ? obj.importance : 5,
    ...(typeof obj.confidence === "number" && !Number.isNaN(obj.confidence) ? { confidence: obj.confidence } : {}),
    created: (obj.created as string) || "",
    lastUsed: (obj.lastUsed as string) || "",
    ...(obj.source ? { source: obj.source as string } : {}),
    ...(obj.sourceHash ? { sourceHash: obj.sourceHash as string } : {}),
    status: obj.status as Memory["status"],
    ...(obj.supersededBy ? { supersededBy: obj.supersededBy as string } : {}),
    ...(obj.validUntil ? { validUntil: obj.validUntil as string } : {}),
    locked: obj.locked === true,
  };
}

export function serializeMemory(m: Memory): string {
  const lines = [`name: ${m.name}`, `type: ${m.type}`, `importance: ${m.importance}`];
  if (m.confidence !== undefined) lines.push(`confidence: ${m.confidence}`);
  lines.push(`created: ${m.created}`, `lastUsed: ${m.lastUsed}`);
  if (m.source) lines.push(`source: ${m.source}`);
  if (m.sourceHash) lines.push(`sourceHash: ${m.sourceHash}`);
  lines.push(`status: ${m.status}`);
  if (m.supersededBy) lines.push(`supersededBy: ${m.supersededBy}`);
  if (m.validUntil) lines.push(`validUntil: ${m.validUntil}`);
  lines.push(`locked: ${m.locked === true}`);
  return `---\n${lines.join("\n")}\n---\n${m.text.trim()}\n`;
}
```

- [ ] **Step 4: 跑测试确认通过** — Run: `npx vitest run src/memory/frontmatter.test.ts` → PASS
- [ ] **Step 5: 提交** — `git commit -am "feat(memory): zero-dep frontmatter parse/serialize"`

---

## Task 3: 内容 hash(给权威验证用)

**Files:**
- Create: `src/memory/hash.ts`
- Test: `src/memory/hash.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/memory/hash.test.ts
import { describe, it, expect } from "vitest";
import { contentHash } from "./hash.js";
describe("contentHash", () => {
  it("stable + sensitive", () => {
    expect(contentHash("abc")).toBe(contentHash("abc"));
    expect(contentHash("abc")).not.toBe(contentHash("abd"));
    expect(contentHash("abc")).toMatch(/^[0-9a-f]{16}$/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — Run: `npx vitest run src/memory/hash.test.ts` → FAIL

- [ ] **Step 3: 实现**

```ts
// src/memory/hash.ts
import { createHash } from "node:crypto";
// 取 sha256 前 16 hex,够区分、frontmatter 里短。
export function contentHash(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}
```

- [ ] **Step 4: 跑测试确认通过** — PASS
- [ ] **Step 5: 提交** — `git commit -am "feat(memory): content hash for source validation"`

---

## Task 4: 读时确定性权威验证

**Files:**
- Create: `src/memory/validate.ts`
- Test: `src/memory/validate.test.ts`

**语义**(成本:**确定性、0 token、会话级跑一次**):
- 无 `source` → 通过(用户模型/世界事实,无代码出处)。
- 有 `source`,源文件**不存在** → `stale`(跳过注入)。
- 有 `source` 且有 `sourceHash`,现内容 hash **不一致** → `changed`(仍注入但正文加"(可能已过期:来源已变,请以实时文件为准)")。
- 否则 → `ok`。
- `validUntil` 已过(< today)→ `stale`。

- [ ] **Step 1: 写失败测试**

```ts
// src/memory/validate.test.ts
import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateMemory } from "./validate.js";
import { newMemory } from "./types.js";
import { contentHash } from "./hash.js";

describe("validateMemory", () => {
  it("passes user facts with no source", async () => {
    const m = newMemory({ name: "u", text: "偏好 TS", type: "user", today: "2026-06-07" });
    expect((await validateMemory(m, "/nope", "2026-06-07")).verdict).toBe("ok");
  });
  it("stale when source file missing", async () => {
    const m = newMemory({ name: "c", text: "x", type: "semantic", today: "2026-06-07", source: "gone.txt", sourceHash: "abc" });
    expect((await validateMemory(m, os.tmpdir(), "2026-06-07")).verdict).toBe("stale");
  });
  it("changed when hash mismatches", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-"));
    await fs.writeFile(path.join(dir, "f.txt"), "NEW");
    const m = newMemory({ name: "c", text: "x", type: "semantic", today: "2026-06-07", source: "f.txt", sourceHash: contentHash("OLD") });
    const r = await validateMemory(m, dir, "2026-06-07");
    expect(r.verdict).toBe("changed");
  });
  it("ok when hash matches", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-"));
    await fs.writeFile(path.join(dir, "f.txt"), "SAME");
    const m = newMemory({ name: "c", text: "x", type: "semantic", today: "2026-06-07", source: "f.txt", sourceHash: contentHash("SAME") });
    expect((await validateMemory(m, dir, "2026-06-07")).verdict).toBe("ok");
  });
  it("stale when past validUntil", async () => {
    const m = { ...newMemory({ name: "v", text: "x", type: "semantic", today: "2026-06-01" }), validUntil: "2026-06-05" };
    expect((await validateMemory(m, "/nope", "2026-06-07")).verdict).toBe("stale");
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — Run: `npx vitest run src/memory/validate.test.ts` → FAIL

- [ ] **Step 3: 实现**(复用 `resolveInWorkspace` 防越界)

```ts
// src/memory/validate.ts
import { promises as fs } from "node:fs";
import type { Memory } from "./types.js";
import { resolveInWorkspace } from "../tools/paths.js";
import { contentHash } from "./hash.js";

export type Verdict = "ok" | "changed" | "stale";
export interface Validation { verdict: Verdict; }

export async function validateMemory(m: Memory, workspaceRoot: string, today: string): Promise<Validation> {
  if (m.validUntil && m.validUntil < today) return { verdict: "stale" };
  if (!m.source) return { verdict: "ok" };
  const rel = m.source.split("#")[0];
  let file: string;
  try { file = resolveInWorkspace(workspaceRoot, rel); } catch { return { verdict: "ok" }; } // 越界 source 不验证,放行
  let content: string;
  try { content = await fs.readFile(file, "utf8"); } catch { return { verdict: "stale" }; }
  if (m.sourceHash && contentHash(content) !== m.sourceHash) return { verdict: "changed" };
  return { verdict: "ok" };
}
```

> 注:若 `resolveInWorkspace` 的导出名/签名不同,按现有 `src/tools/paths.ts` 调整;目标是把 `rel` 解析到工作区内、防 `../` 越界。

- [ ] **Step 4: 跑测试确认通过** — PASS
- [ ] **Step 5: 提交** — `git commit -am "feat(memory): deterministic read-time authority validation"`

---

## Task 5: store 改为 md 目录(加载 + 写入去重/作废 + 旧 JSON 迁移)

**Files:**
- Modify: `src/memory/store.ts`
- Test: `src/memory/store.test.ts`(改写)

**接口**:
- `loadAllMemories(projectDir, userDir)` → `Memory[]`(user 在前;只返回 `status==="active"`)。
- `writeMemory(dir, mem)` → 写 `<dir>/<name>.md`(覆盖)。
- `upsertMemory(dir, candidate, existing)` → 相似度分带去重(≥0.9 视为重复 → 更新旧文件正文+lastUsed,返回 `"updated"`;否则写新文件 `"added"`)。相似度用确定性 token Jaccard(见下)。
- `supersedeMemory(dir, oldName, newName, validUntil)` → 旧文件 `status: superseded` + `supersededBy`/`validUntil`,**不删**。
- `migrateLegacy(dir, today)` → 若存在 `memories.json`,把每条 `{text}` 写成 `type: semantic` 的 md(name 用 slug),旧文件改名 `.migrated`。

- [ ] **Step 1: 写失败测试**(覆盖:加载只取 active、upsert 去重更新、supersede 不删、迁移)

```ts
// src/memory/store.test.ts (核心用例)
import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os"; import path from "node:path";
import { loadAllMemories, upsertMemory, supersedeMemory, migrateLegacy } from "./store.js";
import { newMemory } from "./types.js";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "memstore-"));

describe("store md dir", () => {
  it("upsert dedups near-duplicates, updates existing", async () => {
    const d = await tmp();
    await upsertMemory(d, newMemory({ name: "pnpm", text: "项目用 pnpm 安装依赖", type: "procedural", today: "2026-06-07" }), []);
    const all1 = await loadAllMemories(d, d + "-none");
    const r = await upsertMemory(d, newMemory({ name: "pnpm2", text: "项目用 pnpm 安装依赖包", type: "procedural", today: "2026-06-08" }), all1);
    expect(r.action).toBe("updated");
    const all2 = await loadAllMemories(d, d + "-none");
    expect(all2.length).toBe(1); // 没新增第二条
  });
  it("supersede keeps old file but load skips it", async () => {
    const d = await tmp();
    await upsertMemory(d, newMemory({ name: "api", text: "API 用 v1", type: "semantic", today: "2026-06-07" }), []);
    await upsertMemory(d, newMemory({ name: "api-v2", text: "API 用 v2", type: "semantic", today: "2026-06-08" }), []);
    await supersedeMemory(d, "api", "api-v2", "2026-06-08");
    const all = await loadAllMemories(d, d + "-none");
    expect(all.map((m) => m.name)).toEqual(["api-v2"]); // 旧的被跳过
    expect(await fs.readFile(path.join(d, "api.md"), "utf8")).toMatch(/status: superseded/); // 但文件还在
  });
  it("migrates legacy memories.json", async () => {
    const d = await tmp();
    await fs.writeFile(path.join(d, "memories.json"), JSON.stringify([{ text: "偏好 TypeScript" }]));
    await migrateLegacy(d, "2026-06-07");
    const all = await loadAllMemories(d, d + "-none");
    expect(all[0].text).toBe("偏好 TypeScript");
    expect(all[0].type).toBe("semantic");
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — Run: `npx vitest run src/memory/store.test.ts` → FAIL

- [ ] **Step 3: 实现**(确定性 Jaccard 相似度;无 LLM)

```ts
// src/memory/store.ts
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Memory } from "./types.js";
import { newMemory } from "./types.js";
import { parseMemoryFile, serializeMemory } from "./frontmatter.js";

const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter(Boolean));
function jaccard(a: string, b: string): number {
  const A = tokens(a), B = tokens(b); if (!A.size && !B.size) return 1;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
export const DUP_THRESHOLD = 0.9;

async function readDir(dir: string): Promise<Memory[]> {
  let names: string[]; try { names = await fs.readdir(dir); } catch { return []; }
  const out: Memory[] = [];
  for (const f of names) {
    if (!f.endsWith(".md")) continue;
    const raw = await fs.readFile(path.join(dir, f), "utf8").catch(() => "");
    const m = parseMemoryFile(f.slice(0, -3), raw);
    if (m) out.push(m);
  }
  return out;
}

// user 在前,只返回 active。
export async function loadAllMemories(projectDir: string, userDir: string): Promise<Memory[]> {
  const [u, p] = await Promise.all([readDir(userDir), readDir(projectDir)]);
  return [...u, ...p].filter((m) => m.status === "active");
}

export async function writeMemory(dir: string, m: Memory): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${m.name}.md`), serializeMemory(m), "utf8");
}

// 相似度分带去重:≥阈值 → 更新最相近旧文件正文+lastUsed;否则写新文件。
export async function upsertMemory(dir: string, cand: Memory, existing: Memory[]): Promise<{ action: "added" | "updated"; name: string }> {
  let best: Memory | undefined; let bestS = 0;
  for (const m of existing) {
    if (m.type !== cand.type) continue;
    const s = jaccard(m.text, cand.text);
    if (s > bestS) { bestS = s; best = m; }
  }
  if (best && bestS >= DUP_THRESHOLD && !best.locked) {
    const updated: Memory = { ...best, text: cand.text, lastUsed: cand.lastUsed, importance: Math.max(best.importance, cand.importance) };
    await writeMemory(dir, updated);
    return { action: "updated", name: best.name };
  }
  await writeMemory(dir, cand);
  return { action: "added", name: cand.name };
}

export async function supersedeMemory(dir: string, oldName: string, newName: string, validUntil: string): Promise<void> {
  const raw = await fs.readFile(path.join(dir, `${oldName}.md`), "utf8").catch(() => "");
  const m = parseMemoryFile(oldName, raw); if (!m) return;
  await writeMemory(dir, { ...m, status: "superseded", supersededBy: newName, validUntil });
}

// 旧 JSON 迁移成 md。
export async function migrateLegacy(dir: string, today: string): Promise<void> {
  const legacy = path.join(dir, "memories.json");
  let raw: string; try { raw = await fs.readFile(legacy, "utf8"); } catch { return; }
  let arr: unknown; try { arr = JSON.parse(raw); } catch { return; }
  if (!Array.isArray(arr)) return;
  let i = 0;
  for (const item of arr) {
    const text = item && typeof item.text === "string" ? item.text.trim() : "";
    if (!text) continue;
    const name = (text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "mem") + "-" + i++;
    await writeMemory(dir, newMemory({ name, text, type: "semantic", today }));
  }
  await fs.rename(legacy, legacy + ".migrated").catch(() => {});
}
```

> 删除旧的 `addMemory`/`loadMemoryFile`(被 `upsertMemory`/`loadAllMemories` 取代);更新引用处(`memory_write` 见 Task 6,任何测试随之改)。

- [ ] **Step 4: 跑测试确认通过** — Run: `npx vitest run src/memory/store.test.ts` → PASS
- [ ] **Step 5: 提交** — `git commit -am "feat(memory): md-dir store with banded dedup, supersede, legacy migration"`

---

## Task 6: 升级 memory_write 工具(type/importance/source/confidence)

**Files:**
- Modify: `src/tools/memory_write.ts`
- Test: `src/tools/memory_write.test.ts`(改写)

**行为**:参数加 `type`(默认 semantic)、`importance`(默认 5)、`source`(可选,给则计算 sourceHash)、`confidence`(可选)。写入走 `upsertMemory`(先 `loadAllMemories` 拿现有做去重)。`source` 有则读该文件算 `contentHash` 存入(读不到则不存 hash,仍记 source)。name 由 text 派生 slug。

- [ ] **Step 1: 写失败测试**

```ts
// 核心:带 source 的写入会存 sourceHash;近重复写入返回"更新"。
import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os"; import path from "node:path";
import { memoryWriteTool } from "./memory_write.js";

it("stores sourceHash when source given", async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mw-"));
  await fs.writeFile(path.join(ws, "package.json"), '{"packageManager":"pnpm@9"}');
  const ctx: any = { workspaceRoot: ws, today: "2026-06-07" };
  const out = await memoryWriteTool.handler({ text: "项目用 pnpm", type: "procedural", source: "package.json" }, ctx);
  expect(out).toMatch(/已记住/);
  const files = (await fs.readdir(path.join(ws, ".codeds", "memory"))).filter((f) => f.endsWith(".md"));
  const raw = await fs.readFile(path.join(ws, ".codeds", "memory", files[0]), "utf8");
  expect(raw).toMatch(/source: package.json/);
  expect(raw).toMatch(/sourceHash: [0-9a-f]{16}/);
});
```

- [ ] **Step 2: 跑测试确认失败** — FAIL

- [ ] **Step 3: 实现**

```ts
// src/tools/memory_write.ts
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool } from "./types.js";
import { loadAllMemories, upsertMemory } from "../memory/store.js";
import { newMemory } from "../memory/types.js";
import { contentHash } from "../memory/hash.js";
import { resolveInWorkspace } from "./paths.js";

const memDir = (scope: "project" | "user", ws: string) =>
  path.join(scope === "user" ? os.homedir() : ws, ".codeds", "memory");

function slug(text: string): string {
  return (text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "mem");
}

export const memoryWriteTool = defineTool({
  name: "memory_write",
  description:
    "记录一条跨 session 的稳定记忆。最高价值是【用户模型】:用户信息(环境/技术栈/水平/习惯)、偏好、意图,以及你推断出的、用户没明说的信息/意图(这类把 confidence 设低、type=user)。也可记通用规则(procedural)与项目事实(semantic)。只记耐久且可泛化的,克制使用。若该事实是从某个文件/代码推导出来的,务必填 source(如 'package.json#packageManager'),以便日后对照实时文件验证是否过期。",
  capability: "plan",
  approval: "auto",
  schema: z.object({
    text: z.string().min(1).describe("要记住的事实(一句话)"),
    type: z.enum(["user", "semantic", "procedural", "episodic"]).optional().describe("user=用户模型(默认 semantic)"),
    importance: z.number().int().min(1).max(10).optional().describe("1–10 重要度,默认 5"),
    confidence: z.number().min(0).max(1).optional().describe("用户模型/推断类填,0–1"),
    source: z.string().optional().describe("该事实的代码出处 path 或 path#symbol"),
    scope: z.enum(["project", "user"]).optional().describe("project(默认)或 user"),
  }),
  handler: async (args, ctx: any) => {
    const scope = args.scope ?? "project";
    const dir = memDir(scope, ctx.workspaceRoot);
    const today: string = ctx.today ?? new Date().toISOString().slice(0, 10);
    let sourceHash: string | undefined;
    if (args.source) {
      try {
        const f = resolveInWorkspace(ctx.workspaceRoot, args.source.split("#")[0]);
        sourceHash = contentHash(await fs.readFile(f, "utf8"));
      } catch { /* 读不到就只记 source、不记 hash */ }
    }
    const cand = newMemory({
      name: slug(args.text), text: args.text, type: args.type ?? "semantic", today,
      importance: args.importance, confidence: args.confidence, source: args.source, sourceHash,
    });
    const existing = await loadAllMemories(dir, memDir("user", ctx.workspaceRoot));
    const r = await upsertMemory(dir, cand, existing);
    const label = scope === "user" ? "用户级" : "项目级";
    return r.action === "updated"
      ? `已更新(${label}):${args.text.trim()}`
      : `已记住(${label}):${args.text.trim()}`;
  },
});
```

> 需要 `ctx.today`:在 `ToolContext`(`src/tools/types.ts`)加可选 `today?: string`,index 注入 `new Date().toISOString().slice(0,10)`。便于测试注入固定日期。

- [ ] **Step 4: 跑测试确认通过** — PASS
- [ ] **Step 5: 提交** — `git commit -am "feat(memory): memory_write writes typed md with source provenance"`

---

## Task 7: 会话结束蒸馏(用户模型更新)

**Files:**
- Create: `src/memory/distill.ts`
- Test: `src/memory/distill.test.ts`

**纯函数,便于测试**:`distill({ streamChat, config, messages, today })` → `Memory[]` 候选。内部用**独立一次** `streamChat`(`extra: { thinking: { type: "disabled" }, temperature: 0 }`,可指定 flash 模型省钱),system prompt 让模型输出 JSON 数组:`[{text,type,importance,confidence?,source?}]`,只保留耐久、可泛化、importance≥4 的。解析容错(非 JSON → 返回 [])。

- [ ] **Step 1: 写失败测试**(注入假 streamChat,返回固定 JSON)

```ts
// src/memory/distill.test.ts
import { describe, it, expect } from "vitest";
import { distill } from "./distill.js";

function fakeStream(text: string) {
  return async function* () { yield { kind: "content", text }; return { role: "assistant", content: text }; }();
}

it("parses distilled memories and gates importance", async () => {
  const json = JSON.stringify([
    { text: "用户在学 agent 原理,偏好讲机制", type: "user", importance: 7, confidence: 0.6 },
    { text: "随口一句", type: "episodic", importance: 2 },
  ]);
  const mems = await distill({
    streamChat: () => fakeStream("```json\n" + json + "\n```"),
    config: { baseUrl: "x", apiKey: "x" }, model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "..." }], today: "2026-06-07",
  } as any);
  expect(mems.length).toBe(1); // importance<4 被滤
  expect(mems[0]).toMatchObject({ type: "user", importance: 7, confidence: 0.6 });
  expect(mems[0].created).toBe("2026-06-07");
});

it("returns [] on non-JSON", async () => {
  const mems = await distill({ streamChat: () => fakeStream("抱歉无法"), config: {}, model: "x", messages: [], today: "2026-06-07" } as any);
  expect(mems).toEqual([]);
});
```

- [ ] **Step 2: 跑测试确认失败** — FAIL

- [ ] **Step 3: 实现**

```ts
// src/memory/distill.ts
import type { Memory, MemoryType } from "./types.js";
import { newMemory } from "./types.js";

const SYS = `你是记忆蒸馏器。从给定对话里抽取值得跨会话长期记住的事实,**最看重"关于用户这个人"的信息**:用户的环境/技术栈/水平/习惯(信息)、喜好(偏好)、目标与背后的为什么(意图),以及你能合理推断、但用户没明说的信息或意图(这类 type=user 且 confidence 设低,如 0.4–0.6)。也可记通用可复用规则(procedural)与稳定项目事实(semantic)。
只输出 JSON 数组,每项 {text(一句话), type(user|semantic|procedural|episodic), importance(1-10), confidence(0-1,可选), source(可选,代码出处)}。
只保留耐久、可泛化的;忽略一次性细节与寒暄。无可记则输出 []。只输出 JSON,不要其它文字。`;

function extractJson(s: string): unknown {
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : s;
  const m = body.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export async function distill(p: {
  streamChat: (opts: any) => AsyncGenerator<any, any>;
  config: { baseUrl: string; apiKey: string }; model: string;
  messages: { role: string; content: string | null }[]; today: string;
}): Promise<Memory[]> {
  const rendered = p.messages.map((m) => `${m.role}: ${m.content ?? ""}`).join("\n").slice(0, 24000);
  const gen = p.streamChat({
    baseUrl: p.config.baseUrl, apiKey: p.config.apiKey, model: p.model,
    messages: [{ role: "system", content: SYS }, { role: "user", content: rendered }],
    extra: { thinking: { type: "disabled" }, temperature: 0 },
  });
  let out = ""; let r = await gen.next();
  while (!r.done) { if (r.value?.kind === "content") out += r.value.text; r = await gen.next(); }
  if (!out && typeof r.value?.content === "string") out = r.value.content;
  const arr = extractJson(out);
  if (!Array.isArray(arr)) return [];
  const valid = new Set<MemoryType>(["user", "semantic", "procedural", "episodic"]);
  const mems: Memory[] = [];
  for (const it of arr) {
    if (!it || typeof it.text !== "string" || !valid.has(it.type)) continue;
    const importance = typeof it.importance === "number" ? it.importance : 5;
    if (importance < 4) continue; // salience 门
    mems.push(newMemory({
      name: it.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "mem",
      text: it.text, type: it.type, today: p.today, importance,
      confidence: typeof it.confidence === "number" ? it.confidence : undefined,
      source: typeof it.source === "string" ? it.source : undefined,
    }));
  }
  return mems;
}
```

- [ ] **Step 4: 跑测试确认通过** — PASS
- [ ] **Step 5: 提交** — `git commit -am "feat(memory): session-end distillation into user-model memories"`

---

## Task 8: 接线 index.ts(启动:迁移+加载+验证+注入;退出:蒸馏)

**Files:**
- Modify: `src/index.ts`
- Modify: `src/tools/types.ts`(ToolContext 加 `today?`)
- Test: `src/memory/inject.test.ts`(新,把"加载→验证→拼注入文本"抽成纯函数测)

**抽纯函数** `buildMemorySection(mems, validations)`:把通过验证的记忆拼成 `# 记忆` 段文本;`changed` 的在正文后加"(可能已过期:来源已变,请以实时文件为准)";`stale` 的剔除。便于单测。

- [ ] **Step 1: 写失败测试**

```ts
// src/memory/inject.test.ts
import { describe, it, expect } from "vitest";
import { buildMemorySection } from "./inject.js";
import { newMemory } from "./types.js";

it("drops stale, annotates changed, keeps ok", () => {
  const a = newMemory({ name: "a", text: "事实A", type: "semantic", today: "2026-06-07" });
  const b = newMemory({ name: "b", text: "事实B", type: "semantic", today: "2026-06-07" });
  const c = newMemory({ name: "c", text: "事实C", type: "semantic", today: "2026-06-07" });
  const text = buildMemorySection([
    { mem: a, verdict: "ok" }, { mem: b, verdict: "changed" }, { mem: c, verdict: "stale" },
  ]);
  expect(text).toContain("事实A");
  expect(text).toContain("事实B(可能已过期");
  expect(text).not.toContain("事实C");
});
```

- [ ] **Step 2: 跑测试确认失败** — FAIL

- [ ] **Step 3: 实现 buildMemorySection** + 接 index

```ts
// src/memory/inject.ts
import type { Memory } from "./types.js";
import type { Verdict } from "./validate.js";
export function buildMemorySection(items: { mem: Memory; verdict: Verdict }[]): string {
  const lines: string[] = [];
  for (const { mem, verdict } of items) {
    if (verdict === "stale") continue;
    const suffix = verdict === "changed" ? "(可能已过期:来源已变,请以实时文件为准)" : "";
    lines.push(`- ${mem.text}${suffix}`);
  }
  return lines.join("\n");
}
```

index.ts 接线(伪代码,按现有结构落点):
- 启动:`await migrateLegacy(projectDir, today); await migrateLegacy(userDir, today);` → `const mems = await loadAllMemories(projectDir, userDir);` → 逐条 `validateMemory` → `buildMemorySection` → 填进系统 prompt 的 `{memory}`(替代旧的直接拼 text)。
- ToolContext 注入 `today`。
- 退出蒸馏:在 REPL 退出路径(用户 `/exit` 或 EOF)调用 `distill({ streamChat, config, model: flashModel, messages: session.messages, today })`,对每条 `upsertMemory(projectDir, cand, existing)`;用 try/catch 包裹,蒸馏失败不影响退出。**仅当本会话有 ≥1 轮真实对话时触发**,避免空跑。

- [ ] **Step 4: 跑测试 + 全量回归** — Run: `npx vitest run` → 全绿;`npx tsc --noEmit` → 0 错
- [ ] **Step 5: 提交** — `git commit -am "feat(memory): wire migrate/load/validate/inject + session-end distill into index"`

---

## Task 9: 文档回写 + 真网络验收

**Files:**
- Modify: `docs/2026-06-04-deepseek-coding-agent-design.md`(§7 加"P2 已落地"实测备注)

- [ ] **Step 1: 真网络手测(需 key,会产生费用)**
  1. run1:对话里透露"我在 macOS 上用 pnpm、在学 agent 原理",正常 `/exit`。
  2. 确认 `.codeds/memory/` 下生成了 `type: user` 的 md(用户模型),含合理 confidence。
  3. run2:**新进程**启动,问"我平时用什么包管理器" → 模型据注入记忆直接答 pnpm、不调工具(跨会话"懂我")。
  4. 权威验证:手动制造一条带 `source: package.json#x` 的记忆,改 package.json 内容 → run3 启动该记忆正文带"(可能已过期…)"或被剔。
- [ ] **Step 2: 记录现象**,§7 补"P2 已落地并实测"备注(与 P1 备注同风格)。
- [ ] **Step 3: 提交** — `git commit -am "docs(memory): P2 landed note + real-network acceptance"`

---

## 自检(写完计划回看)

- **成本纪律达成**:稳态每回合 0 额外 LLM 调用(加载/验证/去重/注入全确定性);唯一 LLM 调用是会话结束蒸馏 +1/会话(flash+关思考+温度0)。✅
- **保缓存**:记忆选择+验证只在启动一次、注入固定前缀;中途 `memory_write` 走 §10 既有"下次生效"。✅
- **类型一致**:`Memory`/`Verdict`/`newMemory` 跨 Task 签名一致;`resolveInWorkspace` 按现有 paths.ts 实际导出名校准(实现时确认)。
- **延后明确(P3)**:embedding 检索 + 多信号 relevance 排序、衰减 GC、失败反思→规则、灰区(0.85–0.95)LLM 裁定。
