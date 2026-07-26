# 环境引导信息补全 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `env_snapshot.ts` 的探测补全到顶层目录、系统内存、网络连通性(npm + PyPI)、pip3/yarn/cargo 版本,并把"慢字段"(工具链/git/网络)从"同步 await 阻塞 system prompt 构建"改成"后台探测 + 回合边界延迟补投递",不再拖慢 Ink 交互界面挂载。

**Architecture:** 字段按获取延迟一分为二。快字段(cwd/platform/顶层目录/内存,同步本地操作)继续烘焙进不可变 system prompt 前缀。慢字段(工具链 shell 探测/git/网络 HEAD 探测)改为纯后台运行,结果推入一个模块级队列,复用 `loop.ts` 里已有的 `drainMcpNotices` 回合边界注入机制(新增 `drainEnvNotices` 同款字段)——探测比第一条请求快就在第一条请求前自然到达,比它慢就在下一次面向模型的请求前打 tag 补投递,只投一次。

**Tech Stack:** TypeScript, Node.js >=20(原生 `fetch`/`AbortController`),vitest。

## Global Constraints

- 只探测 npm registry(`registry.npmjs.org`)+ PyPI(`pypi.org`)两个网络目标,不扩展到 GitHub/crates.io/Go proxy(见设计文档"明确排除的范围")。
- 顶层目录列表只列 cwd 直接子项,不递归展开;超过 40 项截断并注明总数。
- 网络探测每个目标独立 1.5 秒超时(`NETWORK_PROBE_TIMEOUT_MS = 1500`),不阻塞其它字段。
- 慢字段(工具链/git/网络)绝不阻塞 Ink 交互界面挂载(`index.ts` 里 `runInkApp` 调用点)。
- 慢字段补充消息只投递一次,不跨压缩强制保留(当作普通历史消息,可被摘要概括)。
- 所有新增探测失败/超时均静默降级(不抛出、不阻塞主流程),延续 `env_snapshot.ts` 现有哲学。
- 设计依据:`docs/superpowers/specs/2026-07-26-env-bootstrap-enrichment-design.md`。

---

## Task 1: 语言/工具链探测补 pip3/yarn/cargo

**Files:**
- Modify: `src/env_snapshot.ts:13-26`(`PROBE_CMD`)
- Test: `src/env_snapshot.test.ts`

**Interfaces:**
- Consumes: 无(在现有 `PROBE_CMD` 数组里加三行,不改函数签名)
- Produces: `gatherEnvSnapshotData` 返回的 `EnvSnapshotData.toolchain` 数组里新增 pip3/yarn/cargo 三条(有则报版本,无则报 `"xxx: not found"`),后续任务直接消费这个数组,不需要新字段。

- [ ] **Step 1: 写失败测试**

在 `src/env_snapshot.test.ts` 的 `describe("gatherEnvSnapshotData", ...)` 块内,紧跟在现有"非 git 目录:探测到工具链..."那条 `it` 后面加:

```ts
  it("补充探测 pip3/yarn/cargo(有则报版本,无则报 not found)", async () => {
    const data = await gatherEnvSnapshotData(ws);
    expect(data).not.toBeNull();
    const joined = data!.toolchain.join(" | ");
    expect(/pip \d|pip3: not found/.test(joined)).toBe(true);
    expect(/yarn [\d.]+|yarn: not found/.test(joined)).toBe(true);
    expect(/cargo \d|cargo: not found/.test(joined)).toBe(true);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/env_snapshot.test.ts -t "pip3/yarn/cargo"`
Expected: FAIL(当前 toolchain 里没有 pip3/yarn/cargo 相关行)

- [ ] **Step 3: 实现**

把 `src/env_snapshot.ts:13-26` 的 `PROBE_CMD` 改成:

```ts
const PROBE_CMD = [
  "echo '@@LANG@@'",
  "(v=$(node --version 2>&1) && echo \"node $v\" || echo 'node: not found')",
  "(v=$(npm --version 2>&1) && echo \"npm $v\" || echo 'npm: not found')",
  "(v=$(pnpm --version 2>&1) && echo \"pnpm $v\" || echo 'pnpm: not found')",
  "(python3 --version 2>&1 || echo 'python3: not found')",
  "(pip3 --version 2>&1 || echo 'pip3: not found')",
  "(go version 2>&1 || echo 'go: not found')",
  "(rustc --version 2>&1 || echo 'rustc: not found')",
  "(java -version 2>&1 | head -1 || echo 'java: not found')",
  "(v=$(yarn --version 2>&1) && echo \"yarn $v\" || echo 'yarn: not found')",
  "(cargo --version 2>&1 || echo 'cargo: not found')",
  "echo '@@GIT_BRANCH@@'",
  "(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)",
  "echo '@@GIT_DIRTY@@'",
  "(git status --porcelain 2>/dev/null || true)",
].join(" && ");
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/env_snapshot.test.ts`
Expected: PASS(全部用例,包括新增的和原有的)

- [ ] **Step 5: 提交**

```bash
git add src/env_snapshot.ts src/env_snapshot.test.ts
git commit -m "feat(env-snapshot): 工具链探测补 pip3/yarn/cargo 版本"
```

---

## Task 2: 快字段——顶层目录 + 系统内存

**Files:**
- Modify: `src/env_snapshot.ts`(顶部 import 区 + 新增函数)
- Test: `src/env_snapshot.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `export function probeTopLevelDir(cwd: string): string[] | null` —— cwd 直接子项(目录名带 `/` 后缀,排除 `.git`,目录优先+字母序),空目录返回 `null`。
  - `export interface MemorySnapshot { totalGB: number; freeGB: number }`
  - `export function probeMemory(): MemorySnapshot | null`
  - `export function formatFastEnvFields(topLevelDir: string[] | null, memory: MemorySnapshot | null, isEn: boolean): string` —— 产出 `- 顶层目录: ...\n- 系统内存: ...` 这种 bullet 文本,供 Task 6 在 `index.ts` 里同步调用、直接烘焙进 system prompt。

- [ ] **Step 1: 写失败测试**

在 `src/env_snapshot.test.ts` 顶部 import 区加 `probeTopLevelDir, probeMemory, formatFastEnvFields`:

```ts
import { gatherEnvSnapshotData, formatEnvSnapshot, probeTopLevelDir, probeMemory, formatFastEnvFields } from "./env_snapshot.js";
```

在文件末尾追加:

```ts
describe("probeTopLevelDir", () => {
  it("列出 cwd 直接子项,目录带斜杠、目录优先、排除 .git", async () => {
    await fs.mkdir(path.join(ws, ".git"));
    await fs.mkdir(path.join(ws, "src"));
    await fs.writeFile(path.join(ws, "package.json"), "{}");
    const names = probeTopLevelDir(ws);
    expect(names).toEqual(["src/", "package.json"]);
  });

  it("空目录 → null", async () => {
    expect(probeTopLevelDir(ws)).toBeNull();
  });

  it("不存在的目录 → null,不抛出", () => {
    expect(probeTopLevelDir(path.join(ws, "does-not-exist"))).toBeNull();
  });

  it("超过 40 项:formatFastEnvFields 截断并注明总数", async () => {
    for (let i = 0; i < 45; i++) await fs.writeFile(path.join(ws, `f${String(i).padStart(2, "0")}.txt`), "x");
    const names = probeTopLevelDir(ws);
    expect(names!.length).toBe(45);
    const out = formatFastEnvFields(names, null, false);
    expect(out).toContain("(共 45 项)");
  });
});

describe("probeMemory", () => {
  it("返回总量/可用量(GB,保留 1 位小数)", () => {
    const mem = probeMemory();
    expect(mem).not.toBeNull();
    expect(mem!.totalGB).toBeGreaterThan(0);
    expect(mem!.freeGB).toBeGreaterThanOrEqual(0);
  });
});

describe("formatFastEnvFields", () => {
  it("zh:目录 + 内存两行", () => {
    const out = formatFastEnvFields(["src/", "package.json"], { totalGB: 16, freeGB: 4.2 }, false);
    expect(out).toContain("顶层目录: src/, package.json");
    expect(out).toContain("系统内存: 16 GB 总量,4.2 GB 可用");
  });

  it("en:目录 + 内存两行", () => {
    const out = formatFastEnvFields(["src/"], { totalGB: 16, freeGB: 4.2 }, true);
    expect(out).toContain("Top-level entries: src/");
    expect(out).toContain("System memory: 16 GB total, 4.2 GB free");
  });

  it("两项都为 null → 空串", () => {
    expect(formatFastEnvFields(null, null, false)).toBe("");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/env_snapshot.test.ts -t "probeTopLevelDir|probeMemory|formatFastEnvFields"`
Expected: FAIL(`probeTopLevelDir`/`probeMemory`/`formatFastEnvFields` 尚未导出)

- [ ] **Step 3: 实现**

在 `src/env_snapshot.ts` 顶部 import 区(现有 `import { spawn } from "node:child_process";`)加:

```ts
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import os from "node:os";
import { scrubbedEnv } from "./tools/safe_env.js";
```

在文件末尾(`formatEnvSnapshot` 之后)追加:

```ts
const TOP_LEVEL_DIR_CAP = 40;

/** 只列 cwd 直接子项(不递归),排除 .git(已有 git 分支信息,重复无意义)。
 *  目录优先、字母序,失败(权限/不存在/空目录)一律静默返回 null。 */
export function probeTopLevelDir(cwd: string): string[] | null {
  let entries;
  try {
    entries = readdirSync(cwd, { withFileTypes: true });
  } catch {
    return null;
  }
  const names = entries
    .filter((e) => e.name !== ".git")
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort((a, b) => {
      const aDir = a.endsWith("/");
      const bDir = b.endsWith("/");
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.localeCompare(b);
    });
  return names.length ? names : null;
}

export interface MemorySnapshot {
  totalGB: number;
  freeGB: number;
}

export function probeMemory(): MemorySnapshot | null {
  try {
    const total = os.totalmem();
    const free = os.freemem();
    if (!total) return null;
    return {
      totalGB: Math.round((total / 1024 ** 3) * 10) / 10,
      freeGB: Math.round((free / 1024 ** 3) * 10) / 10,
    };
  } catch {
    return null;
  }
}

/** 快字段(顶层目录+内存):纯同步本地操作,零 I/O 等待,由调用方直接拼进不可变 system prompt 前缀。 */
export function formatFastEnvFields(
  topLevelDir: string[] | null,
  memory: MemorySnapshot | null,
  isEn: boolean,
): string {
  const parts: string[] = [];
  if (topLevelDir && topLevelDir.length) {
    const capped = topLevelDir.slice(0, TOP_LEVEL_DIR_CAP);
    const suffix =
      topLevelDir.length > TOP_LEVEL_DIR_CAP
        ? isEn
          ? `, ...(${topLevelDir.length} total)`
          : `,...(共 ${topLevelDir.length} 项)`
        : "";
    parts.push(`${isEn ? "Top-level entries" : "顶层目录"}: ${capped.join(", ")}${suffix}`);
  }
  if (memory) {
    parts.push(
      isEn
        ? `System memory: ${memory.totalGB} GB total, ${memory.freeGB} GB free`
        : `系统内存: ${memory.totalGB} GB 总量,${memory.freeGB} GB 可用`,
    );
  }
  return parts.length ? `- ${parts.join("\n- ")}` : "";
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/env_snapshot.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/env_snapshot.ts src/env_snapshot.test.ts
git commit -m "feat(env-snapshot): 新增顶层目录/系统内存快字段探测与格式化"
```

---

## Task 3: 网络连通性探测(npm + PyPI)

**Files:**
- Modify: `src/env_snapshot.ts`
- Test: `src/env_snapshot.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `export interface NetworkProbeResult { reachable: Record<string, boolean>; proxy: string | null }`
  - `export async function probeNetwork(timeoutMs?: number): Promise<NetworkProbeResult>` —— 并行探测 `"npm registry"`/`"PyPI"` 两个 key,默认超时 `NETWORK_PROBE_TIMEOUT_MS = 1500`。
  - `EnvSnapshotData` 新增 `network: NetworkProbeResult | null` 字段。
  - `gatherEnvSnapshotData` 的 shell 探测与网络探测改为并行(`Promise.allSettled`),任一方失败不影响另一方。
- **行为变化(需更新既有测试)**:网络探测不依赖 cwd/shell 探测是否成功,因此"目录不存在"和"极小超时"这两个原本断言 `data === null` 的用例,现在会因为网络探测独立完成而返回非 null 的对象(工具链/git 仍为空,network 字段体现"不可达")。

- [ ] **Step 1: 写失败测试(含更新既有断言)**

在 `src/env_snapshot.test.ts` 顶部把 import 从:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
```

改成:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
```

并把 `import { gatherEnvSnapshotData, ... } from "./env_snapshot.js";` 扩展进 `probeNetwork`:

```ts
import { gatherEnvSnapshotData, formatEnvSnapshot, probeTopLevelDir, probeMemory, formatFastEnvFields, probeNetwork } from "./env_snapshot.js";
```

把现有的 `beforeEach`/`afterEach` 改成:

```ts
beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "dao-envsnap-"));
  // 默认模拟"无网络",避免单测真的打外网(慢/flaky/CI 沙箱可能本来就没网)。
  // 需要"网络可达"场景的用例自己覆盖这个 stub。
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
});
afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
  vi.unstubAllGlobals();
});
```

把原有这条用例:

```ts
  it("超时预算极小时静默返回 null(不抛出、不挂起)", async () => {
    const data = await gatherEnvSnapshotData(ws, 1);
    expect(data).toBeNull();
  });
```

改成:

```ts
  it("超时预算极小时:工具链/git 为空,网络探测独立完成、显示不可达(不抛出、不挂起)", async () => {
    const data = await gatherEnvSnapshotData(ws, 1);
    expect(data).not.toBeNull();
    expect(data!.toolchain).toEqual([]);
    expect(data!.gitBranch).toBeNull();
    expect(data!.network?.reachable["npm registry"]).toBe(false);
    expect(data!.network?.reachable["PyPI"]).toBe(false);
  });
```

把原有这条用例:

```ts
  it("不存在的目录:静默返回 null,不抛出", async () => {
    const data = await gatherEnvSnapshotData(path.join(ws, "does-not-exist"));
    expect(data).toBeNull();
  });
```

改成:

```ts
  it("不存在的目录:工具链/git 探测失败,网络探测仍独立完成、不抛出", async () => {
    const data = await gatherEnvSnapshotData(path.join(ws, "does-not-exist"));
    expect(data).not.toBeNull();
    expect(data!.toolchain).toEqual([]);
    expect(data!.gitBranch).toBeNull();
    expect(data!.network).not.toBeNull();
  });
```

`EnvSnapshotData` 新增了必填的 `network` 字段,`describe("formatEnvSnapshot", ...)` 块里另外 4 条直接构造 `EnvSnapshotData` 字面量的既有用例现在编译不过,一并补上 `network: null`(否则这一步 typecheck 就会先炸,等不到 Task 4)。把这 4 条改成:

```ts
  it("zh:格式化工具链 + 干净分支", () => {
    const out = formatEnvSnapshot(
      { toolchain: ["node v20.0.0"], gitBranch: "master", gitDirtyCount: 0, network: null },
      false,
    );
    expect(out).toContain("可用语言/工具: node v20.0.0");
    expect(out).toContain("Git 分支: master (干净)");
  });

  it("zh:脏分支显示改动数", () => {
    const out = formatEnvSnapshot({ toolchain: [], gitBranch: "master", gitDirtyCount: 3, network: null }, false);
    expect(out).toContain("3 个未提交改动");
  });

  it("en:格式化工具链 + branch", () => {
    const out = formatEnvSnapshot(
      { toolchain: ["node v20.0.0"], gitBranch: "master", gitDirtyCount: 0, network: null },
      true,
    );
    expect(out).toContain("Available languages/tools: node v20.0.0");
    expect(out).toContain("Git branch: master (clean)");
  });

  it("既无工具链也无分支也无网络 → 空串", () => {
    expect(
      formatEnvSnapshot({ toolchain: [], gitBranch: null, gitDirtyCount: null, network: null }, false),
    ).toBe("");
  });
```

在文件末尾追加:

```ts
describe("probeNetwork", () => {
  it("npm 可达、PyPI 不可达:分别报告", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url.includes("npmjs")
          ? Promise.resolve(new Response(null, { status: 200 }))
          : Promise.reject(new Error("unreachable")),
      ),
    );
    const result = await probeNetwork(50);
    expect(result.reachable["npm registry"]).toBe(true);
    expect(result.reachable["PyPI"]).toBe(false);
  });

  it("超时:AbortController 触发,判定为不可达,不挂起", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
      ),
    );
    const result = await probeNetwork(20);
    expect(result.reachable["npm registry"]).toBe(false);
    expect(result.reachable["PyPI"]).toBe(false);
  });

  it("代理环境变量:附带在结果里", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    const prev = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
    const result = await probeNetwork(50);
    expect(result.proxy).toBe("http://127.0.0.1:7890");
    if (prev === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = prev;
  });

  it("无代理变量 → proxy 为 null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    const result = await probeNetwork(50);
    expect(result.proxy).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/env_snapshot.test.ts`
Expected: FAIL(`probeNetwork` 未导出;`gatherEnvSnapshotData` 尚无 `network` 字段;两条改写过的 null 断言用例仍会拿到 `null`)

- [ ] **Step 3: 实现**

在 `src/env_snapshot.ts` 的 `EnvSnapshotData` 接口和 `runProbe` 之间插入:

```ts
const NETWORK_PROBE_TIMEOUT_MS = 1500;
const NETWORK_TARGETS: Array<{ name: string; url: string }> = [
  { name: "npm registry", url: "https://registry.npmjs.org" },
  { name: "PyPI", url: "https://pypi.org" },
];

async function probeOneHost(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "HEAD", signal: controller.signal });
    return res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface NetworkProbeResult {
  reachable: Record<string, boolean>;
  proxy: string | null;
}

/** 两个目标并行探测,各自独立超时/失败,不互相拖累。代理变量只读不发请求,零延迟零风险。 */
export async function probeNetwork(timeoutMs: number = NETWORK_PROBE_TIMEOUT_MS): Promise<NetworkProbeResult> {
  const results = await Promise.all(NETWORK_TARGETS.map((t) => probeOneHost(t.url, timeoutMs)));
  const reachable: Record<string, boolean> = {};
  NETWORK_TARGETS.forEach((t, i) => {
    reachable[t.name] = results[i]!;
  });
  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    null;
  return { reachable, proxy };
}
```

把 `EnvSnapshotData` 接口改成:

```ts
export interface EnvSnapshotData {
  toolchain: string[];
  gitBranch: string | null;
  gitDirtyCount: number | null; // null = 非 git 仓库(或探测不到分支)
  network: NetworkProbeResult | null;
}
```

把 `gatherEnvSnapshotData` 整个函数体替换成:

```ts
/** 探测运行时/工具链 + git 状态 + 网络连通性;shell 探测与网络探测并行、各自独立超时/失败,
 *  任一方出问题都不影响另一方,也绝不阻塞或抛出到调用方主流程之外。
 *  timeoutMs 仅供测试注入极小值验证超时路径;生产调用方一律用默认值。 */
export async function gatherEnvSnapshotData(
  cwd: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
  networkTimeoutMs: number = NETWORK_PROBE_TIMEOUT_MS,
): Promise<EnvSnapshotData | null> {
  const [shellResult, networkResult] = await Promise.allSettled([
    runProbe(cwd, timeoutMs),
    probeNetwork(networkTimeoutMs),
  ]);

  let toolchain: string[] = [];
  let gitBranch: string | null = null;
  let gitDirtyCount: number | null = null;
  if (shellResult.status === "fulfilled" && shellResult.value.trim()) {
    const stdout = shellResult.value;
    const sections: Record<string, string[]> = {};
    let key = "";
    for (const line of stdout.split("\n")) {
      const m = line.match(/^@@(\w+)@@$/);
      if (m?.[1]) {
        key = m[1];
        sections[key] = [];
        continue;
      }
      if (key) sections[key]?.push(line);
    }
    toolchain = (sections.LANG ?? []).map((l) => l.trim()).filter(Boolean);
    gitBranch = (sections.GIT_BRANCH ?? []).join("").trim() || null;
    gitDirtyCount = gitBranch
      ? (sections.GIT_DIRTY ?? []).map((l) => l.trim()).filter(Boolean).length
      : null;
  }

  const network = networkResult.status === "fulfilled" ? networkResult.value : null;

  if (toolchain.length === 0 && !gitBranch && !network) return null;
  return { toolchain, gitBranch, gitDirtyCount, network };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/env_snapshot.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/env_snapshot.ts src/env_snapshot.test.ts
git commit -m "feat(env-snapshot): 新增网络连通性探测(npm+PyPI),shell/网络探测互相独立"
```

---

## Task 4: 慢字段格式化扩展(网络行) + 延迟补投递 tag 包装

**Files:**
- Modify: `src/env_snapshot.ts`
- Test: `src/env_snapshot.test.ts`

**Interfaces:**
- Consumes: `EnvSnapshotData`(Task 3 产出,含 `network` 字段)
- Produces:
  - `formatEnvSnapshot` 扩展:新增网络 bullet 行。
  - `export function wrapDelayedEnvNotice(formatted: string, isEn: boolean): string` —— 把 `formatEnvSnapshot` 的输出包上 `<环境探测补充>`/`<environment-probe>` tag;输入空串时原样返回空串(不产出空 tag)。Task 6 会用它构建推进 `envNoticeQueue` 的内容。

- [ ] **Step 1: 写失败测试**

在 `src/env_snapshot.test.ts` 的 `describe("formatEnvSnapshot", ...)` 块内追加:

```ts
  it("zh:网络可达/不可达分别列出,附代理", () => {
    const out = formatEnvSnapshot(
      {
        toolchain: [],
        gitBranch: null,
        gitDirtyCount: null,
        network: { reachable: { "npm registry": true, "PyPI": false }, proxy: "http://127.0.0.1:7890" },
      },
      false,
    );
    expect(out).toContain("网络: 可访问 npm registry;不可访问 PyPI(经代理 http://127.0.0.1:7890)");
  });

  it("en:网络行", () => {
    const out = formatEnvSnapshot(
      { toolchain: [], gitBranch: null, gitDirtyCount: null, network: { reachable: { "npm registry": true, "PyPI": true }, proxy: null } },
      true,
    );
    expect(out).toContain("Network: reachable npm registry, PyPI");
  });

  it("network 为 null → 不产出网络行(其它字段照常显示)", () => {
    const out = formatEnvSnapshot({ toolchain: ["node v20"], gitBranch: null, gitDirtyCount: null, network: null }, false);
    expect(out).toContain("可用语言/工具: node v20");
    expect(out).not.toContain("网络");
  });
```

(`既无工具链也无分支也无网络 → 空串"` 这条纯空值用例已经在 Task 3 里加过了,这里不用重复。)

在文件末尾追加:

```ts
describe("wrapDelayedEnvNotice", () => {
  it("空内容 → 空串,不产出空 tag", () => {
    expect(wrapDelayedEnvNotice("", false)).toBe("");
  });

  it("非空内容包上说明 tag(zh)", () => {
    const out = wrapDelayedEnvNotice("- 可用语言/工具: node v20", false);
    expect(out).toContain("<环境探测补充");
    expect(out).toContain("- 可用语言/工具: node v20");
    expect(out).toContain("</环境探测补充>");
  });

  it("非空内容包上说明 tag(en)", () => {
    const out = wrapDelayedEnvNotice("- Available languages/tools: node v20", true);
    expect(out).toContain("<environment-probe");
    expect(out).toContain("</environment-probe>");
  });
});
```

并在顶部 import 加 `wrapDelayedEnvNotice`:

```ts
import { gatherEnvSnapshotData, formatEnvSnapshot, probeTopLevelDir, probeMemory, formatFastEnvFields, probeNetwork, wrapDelayedEnvNotice } from "./env_snapshot.js";
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/env_snapshot.test.ts`
Expected: FAIL(网络行未格式化;`wrapDelayedEnvNotice` 未导出;既有用例因缺 `network` 字段类型报错)

- [ ] **Step 3: 实现**

把 `src/env_snapshot.ts` 里的 `formatEnvSnapshot` 函数体(`if (data.gitBranch) { ... }` 之后、`return parts.length ? ...` 之前)加一段:

```ts
  if (data.network) {
    const entries = Object.entries(data.network.reachable);
    const reachableNames = entries.filter(([, ok]) => ok).map(([name]) => name);
    const unreachableNames = entries.filter(([, ok]) => !ok).map(([name]) => name);
    const bits: string[] = [];
    if (reachableNames.length) bits.push(`${isEn ? "reachable" : "可访问"} ${reachableNames.join(", ")}`);
    if (unreachableNames.length) bits.push(`${isEn ? "unreachable" : "不可访问"} ${unreachableNames.join(", ")}`);
    const proxyNote = data.network.proxy
      ? isEn
        ? ` (via proxy ${data.network.proxy})`
        : `(经代理 ${data.network.proxy})`
      : "";
    if (bits.length) parts.push(`${isEn ? "Network" : "网络"}: ${bits.join(isEn ? "; " : ";")}${proxyNote}`);
  }
```

在文件末尾(`formatFastEnvFields` 之后)追加:

```ts
/** 慢字段(工具链/git/网络)如果比第一条请求慢,补投递时用这个包一层 tag,明确告诉模型
 *  这是启动时发起、异步延迟才到达的信息,不是当场发生的——避免模型误判"刚刚才变化"。 */
export function wrapDelayedEnvNotice(formatted: string, isEn: boolean): string {
  if (!formatted.trim()) return "";
  return isEn
    ? `<environment-probe note="probing started at process launch; this arrived after your first reply because async I/O was slower">\n${formatted}\n</environment-probe>`
    : `<环境探测补充 说明="进程启动时已发起探测,因异步 I/O 比第一条消息慢完成,现在补上">\n${formatted}\n</环境探测补充>`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/env_snapshot.test.ts`
Expected: PASS(全部用例)

- [ ] **Step 5: 提交**

```bash
git add src/env_snapshot.ts src/env_snapshot.test.ts
git commit -m "feat(env-snapshot): formatEnvSnapshot 加网络行,新增延迟补投递 tag 包装函数"
```

---

## Task 5: loop.ts —— TurnDeps.drainEnvNotices

**Files:**
- Modify: `src/agent/loop.ts:54-124`(`TurnDeps` 接口)、`src/agent/loop.ts:369-377`(drain 消费区)
- Test: `src/agent/loop.test.ts`

**Interfaces:**
- Consumes: 无(纯回调注入,和 `drainMcpNotices` 同款)
- Produces: `TurnDeps.drainEnvNotices?: () => string[]`——每次工具轮边界(含每个用户回合的第一次请求前)被调用一次,返回的每条字符串作为 `role: "system"` 消息 push 进 `session.messages`。Task 6 会传入 `() => envNoticeQueue.splice(0)`。

- [ ] **Step 1: 写失败测试**

在 `src/agent/loop.test.ts` 里,紧跟在现有 `it("drainNotifications:...")` 那条用例后面(可参照它和 `drainAdvisories` 用例的写法)追加:

```ts
  it("drainEnvNotices:回合边界把环境探测补充注入为 system 消息(不发可见提示)", async () => {
    const s = new Session("SYS", "m");
    s.addUser("go");
    let drained = false;
    const out: string[] = [];
    await runTurn({
      session: s, config, registry: emptyReg(), ctx, gate: stubGate,
      streamChat: turn([{ kind: "content", text: "done" }], { role: "assistant", content: "done" }) as any,
      executeToolCalls: async () => [],
      write: (sx) => out.push(sx),
      drainEnvNotices: () => (drained ? [] : (drained = true, ["<环境探测补充>...</环境探测补充>"])),
    });
    expect(s.messages.some((m) => m.role === "system" && String(m.content).includes("<环境探测补充>"))).toBe(true);
  });

  it("drainEnvNotices:只投递一次,不重复注入", async () => {
    const s = new Session("SYS", "m");
    s.addUser("go");
    let calls = 0;
    await runTurn({
      session: s, config, registry: emptyReg(), ctx, gate: stubGate,
      streamChat: scripted([
        turn([], { role: "assistant", content: null, tool_calls: [{ id: "w", type: "function", function: { name: "Write", arguments: "{}" } }] }),
        turn([{ kind: "content", text: "done" }], { role: "assistant", content: "done" }),
      ]),
      executeToolCalls: async () => [{ role: "tool", tool_call_id: "w", content: "ok" }],
      write: () => {},
      drainEnvNotices: () => { calls++; return calls === 1 ? ["<环境探测补充>...</环境探测补充>"] : []; },
    });
    const count = s.messages.filter((m) => m.role === "system" && String(m.content).includes("<环境探测补充>")).length;
    expect(count).toBe(1);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/agent/loop.test.ts -t "drainEnvNotices"`
Expected: FAIL(`drainEnvNotices` 不是 `TurnDeps` 的已知字段,或注入逻辑不存在)

- [ ] **Step 3: 实现**

在 `src/agent/loop.ts` 的 `TurnDeps` 接口里,`drainMcpNotices?: () => string[];`(约第 88 行)后面加:

```ts
  // 回合边界注入的环境探测补充(system 角色):env_snapshot.ts 的慢字段(工具链/git/网络)
  // 后台探测完才就绪,若比第一条请求慢,就在下一次面向模型的请求前(不限定用户轮次,同一用户
  // 回合内的工具轮边界也算)补投递一条打了 tag 的 system 消息。只投一次,省略=不启用(子代理/
  // eval 不需要这个)。
  drainEnvNotices?: () => string[];
```

在 `runTurn` 函数体里,紧跟在现有 `drainMcpNotices` 消费块(约第 371-376 行)后面加:

```ts
    // 环境探测补充:不发 events.notice——这是背景元信息,不像 MCP 状态变化/审视者介入那样
    // 需要用户立刻关注,静默注入即可,模型看到 tag 自然知道怎么用。
    if (deps.drainEnvNotices) {
      for (const n of deps.drainEnvNotices()) {
        session.messages.push({ role: "system", content: n });
      }
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/agent/loop.test.ts`
Expected: PASS(全部用例)

- [ ] **Step 5: 提交**

```bash
git add src/agent/loop.ts src/agent/loop.test.ts
git commit -m "feat(loop): 新增 drainEnvNotices,回合边界补投递环境探测补充"
```

---

## Task 6: index.ts 接线——快字段同步入 prompt、envNoticeQueue、两处 runTurn 挂 drainEnvNotices

**Files:**
- Modify: `src/index.ts`(import 区、~781 行 `envSnapshot` 构建、~796 行之后新增队列、~1327/~1608 两处 `runTurn` 调用)

**Interfaces:**
- Consumes: Task 2 的 `probeTopLevelDir`/`probeMemory`/`formatFastEnvFields`,Task 3 的 `gatherEnvSnapshotData`(签名不变,调用点不变,仍在 `index.ts:297` 发起),Task 4 的 `formatEnvSnapshot`/`wrapDelayedEnvNotice`,Task 5 的 `TurnDeps.drainEnvNotices`。
- Produces: 无新导出——这是纯接线任务,把前面几个任务产出的函数串起来生效。

**说明:`index.ts` 是 CLI 入口文件,仓库里没有对它的自动化单测(`ls src/index.test.ts` 不存在,也没有测试文件 import 它),这个任务用手动冒烟验证收尾,不是缺失覆盖——和这个文件里其它 CLI 接线代码的测试边界一致。**

- [ ] **Step 1: 更新 import**

把 `src/index.ts:32` 的:

```ts
import { gatherEnvSnapshotData, formatEnvSnapshot } from "./env_snapshot.js";
```

改成:

```ts
import { gatherEnvSnapshotData, formatEnvSnapshot, probeTopLevelDir, probeMemory, formatFastEnvFields, wrapDelayedEnvNotice } from "./env_snapshot.js";
```

- [ ] **Step 2: 快字段同步拼入 system prompt(不再阻塞)**

把 `src/index.ts:780-781` 的:

```ts
  const interactiveSession = process.stdin.isTTY === true && !argvPrompt;
  const envSnapshot = formatEnvSnapshot(await envSnapshotPromise, lang === "en");
```

改成:

```ts
  const interactiveSession = process.stdin.isTTY === true && !argvPrompt;
  // 快字段(顶层目录/内存)同步瞬时,直接拼进不可变 system prompt。慢字段(工具链/git/网络)
  // 不再同步 await——见下方 envNoticeQueue,避免网络探测拖慢 Ink 挂载(index.ts 里的 runInkApp)。
  const envSnapshot = formatFastEnvFields(probeTopLevelDir(workspaceRoot), probeMemory(), lang === "en");
```

- [ ] **Step 3: 慢字段队列**

在 `src/index.ts` 里 `systemPrompt` 构建语句结束之后(即现有 `}) + agentTypesSection + skillsSection;` 那一行之后)加:

```ts
  // 慢字段(工具链/git/网络):envSnapshotPromise 在 index.ts:297 就已经发起、和 onboarding 等
  // 慢启动流程并发跑;这里只是等它就绪后格式化打 tag、推进队列。loop.ts 的 drainEnvNotices 在
  // 下一次面向模型的请求前统一消费——赶上第一条请求就自然随它一起出现,赶不上就在下一次请求
  // 前补投递,只投一次,不阻塞任何交互界面挂载。
  const envNoticeQueue: string[] = [];
  envSnapshotPromise.then((data) => {
    const formatted = wrapDelayedEnvNotice(formatEnvSnapshot(data, lang === "en"), lang === "en");
    if (formatted) envNoticeQueue.push(formatted);
  });
```

- [ ] **Step 4: 两处 `runTurn` 调用挂 `drainEnvNotices`**

在 `src/index.ts` 里搜索 `drainMcpNotices: () => mcpChangeQueue.splice(0),`(会命中两处:headless 的 `runOneTurn` 内,以及 Ink 交互提交处理器内),在**每一处**紧跟着加一行:

```ts
            drainMcpNotices: () => mcpChangeQueue.splice(0), // MCP server 状态变化:回合边界回灌,不插进 tool_use/result 中间
            drainEnvNotices: () => envNoticeQueue.splice(0), // 环境探测补充:回合边界回灌(Task 5 新增)
```

(注意两处调用的参数对象缩进不同,照抄各自现有 `drainMcpNotices` 那一行的缩进级别加在它后面即可,不要改动其它字段的顺序。)

- [ ] **Step 5: typecheck**

Run: `npm run typecheck`
Expected: 无新增类型错误

- [ ] **Step 6: 手动冒烟验证**

Run: `npm run dev`(即 `tsx src/index.ts`),在一个真实项目目录下启动交互模式:

1. 确认 Ink 界面挂载后可以立刻输入(不应有明显卡顿——对比改动前后主观感受即可,这个仓库没有自动化的启动耗时基准)。
2. 发一条简单消息(如 "你好"),等模型回复后,用 `/verbose` 或直接看终端里模型是否提到了顶层目录/系统内存(system prompt 里的快字段应该在第一条请求就已经存在)。
3. 观察后续几轮对话,确认某个时刻模型上下文里出现了 `<环境探测补充>` 包裹的工具链/git/网络信息(具体在第几轮取决于慢探测完成得多快,不追求确定性时机)。
4. 用 `DAO_VERBOSE=1`(或仓库已有的等价 debug 开关)确认没有报错/未捕获异常。

如果第 1 步观察到明显的启动卡顿,或第 3 步始终没有等到补充信息出现,回头检查 Task 3-5 的实现,不要跳过这一步直接提交。

- [ ] **Step 7: 提交**

```bash
git add src/index.ts
git commit -m "feat(index): 环境快字段同步入 prompt、慢字段解耦为回合边界补投递,不再阻塞 Ink 挂载"
```

---

## 收尾:全量测试 + typecheck

- [ ] **Step 1**

Run: `npm test`
Expected: PASS(全量 vitest 套件,含本计划新增/修改的所有用例)

- [ ] **Step 2**

Run: `npm run typecheck`
Expected: 无类型错误

- [ ] **Step 3**

对照 `docs/superpowers/specs/2026-07-26-env-bootstrap-enrichment-design.md` 逐条过一遍"设计方案"/"边界情况"小节,确认每一条都能指向本计划里的具体任务(Task 1-6),没有遗漏。
