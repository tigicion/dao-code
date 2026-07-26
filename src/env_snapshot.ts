import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import os from "node:os";
import { scrubbedEnv } from "./tools/safe_env.js";

// 会话启动时探测一次(语言运行时 + git 分支/脏状态),塞进系统提示词的 Environment 段落,
// 省掉模型自己用 Bash 摸索"这台机器有没有 python3/go/当前在哪个分支"的早期回合。
// 灵感来自 stanford-iris-lab/meta-harness 的 environment bootstrapping,但探测在本地 spawn,
// 远比其对远程沙箱 exec 的延迟低,超时预算相应收紧。
//
// ⚠️ 只在启动时调一次,结果原样进 system prompt 固定前缀——绝不能在会话中途重复探测,
// 否则每次结果字节不同会打穿 prefix cache(参见 system_prompt.ts 里的缓存纪律注释)。
const PROBE_TIMEOUT_MS = 3000;

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

export interface EnvSnapshotData {
  toolchain: string[];
  gitBranch: string | null;
  gitDirtyCount: number | null; // null = 非 git 仓库(或探测不到分支)
  network: NetworkProbeResult | null;
}

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

function runProbe(cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    let done = false;
    const child = spawn(PROBE_CMD, { cwd, shell: true, detached: true, env: scrubbedEnv() });
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
      finish(new Error("env snapshot probe timed out"));
    }, timeoutMs);
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(out);
    };
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.on("error", (e) => finish(e as Error));
    child.on("close", () => finish());
  });
}

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

/** 纯格式化,不做 I/O——语言选择与探测时机解耦,方便在 onboarding 改语言后仍能正确渲染。 */
export function formatEnvSnapshot(data: EnvSnapshotData | null, isEn: boolean): string {
  if (!data) return "";
  const parts: string[] = [];
  if (data.toolchain.length) {
    parts.push(
      `${isEn ? "Available languages/tools" : "可用语言/工具"}: ${data.toolchain.join("; ")}`,
    );
  }
  if (data.gitBranch) {
    const dirty = data.gitDirtyCount ?? 0;
    const status =
      dirty > 0
        ? isEn
          ? `${dirty} uncommitted change(s)`
          : `${dirty} 个未提交改动`
        : isEn
          ? "clean"
          : "干净";
    parts.push(`${isEn ? "Git branch" : "Git 分支"}: ${data.gitBranch} (${status})`);
  }
  return parts.length ? `- ${parts.join("\n- ")}` : "";
}

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
