import { spawn } from "node:child_process";
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

/** 探测运行时/工具链 + git 状态;超时或任何失败都静默返回 null,绝不阻塞或抛出到调用方主流程之外。
 *  timeoutMs 仅供测试注入极小值验证超时路径;生产调用方一律用默认值。 */
export async function gatherEnvSnapshotData(
  cwd: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<EnvSnapshotData | null> {
  let stdout: string;
  try {
    stdout = await runProbe(cwd, timeoutMs);
  } catch {
    return null;
  }
  if (!stdout.trim()) return null;

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

  const toolchain = (sections.LANG ?? []).map((l) => l.trim()).filter(Boolean);
  const gitBranch = (sections.GIT_BRANCH ?? []).join("").trim() || null;
  const gitDirtyCount = gitBranch
    ? (sections.GIT_DIRTY ?? []).map((l) => l.trim()).filter(Boolean).length
    : null;

  if (toolchain.length === 0 && !gitBranch) return null;
  return { toolchain, gitBranch, gitDirtyCount };
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
