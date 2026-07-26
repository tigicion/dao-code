import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gatherEnvSnapshotData, formatEnvSnapshot, probeTopLevelDir, probeMemory, formatFastEnvFields, probeNetwork } from "./env_snapshot.js";

let ws: string;
beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "dao-envsnap-"));
  // 默认模拟"无网络",避免单测真的打外网(慢/flaky/CI 沙箱可能本来就没网)。
  // 需要"网络可达"场景的用例自己覆盖这个 stub。
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
});
afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** probeNetwork 读的全部代理变量。测试必须把六个都隔离掉,否则跑测试的机器/CI 上真实存在的代理会污染断言。 */
const PROXY_ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] as const;
function stubProxyEnvCleared(): void {
  for (const k of PROXY_ENV_KEYS) vi.stubEnv(k, undefined);
}

describe("gatherEnvSnapshotData", () => {
  it("非 git 目录:探测到工具链,gitBranch/gitDirtyCount 为 null", async () => {
    const data = await gatherEnvSnapshotData(ws);
    expect(data).not.toBeNull();
    // 跑测试的机器本身就装了 node,这条必然探测到
    expect(data!.toolchain.some((l) => /node/i.test(l))).toBe(true);
    expect(data!.gitBranch).toBeNull();
    expect(data!.gitDirtyCount).toBeNull();
  });

  it("补充探测 pip3/yarn/cargo(有则报版本,无则报 not found)", async () => {
    const data = await gatherEnvSnapshotData(ws);
    expect(data).not.toBeNull();
    const joined = data!.toolchain.join(" | ");
    expect(/pip \d|pip3: not found/.test(joined)).toBe(true);
    expect(/yarn [\d.]+|yarn: not found/.test(joined)).toBe(true);
    expect(/cargo \d|cargo: not found/.test(joined)).toBe(true);
  });

  it("git 仓库(干净):探测到分支、脏文件数为 0", async () => {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
    execFileSync("git", ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"], { cwd: ws });

    const data = await gatherEnvSnapshotData(ws);
    expect(data).not.toBeNull();
    expect(data!.gitBranch).toBe("main");
    expect(data!.gitDirtyCount).toBe(0);
  });

  it("git 仓库(有未提交改动):脏文件数 > 0", async () => {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
    execFileSync("git", ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"], { cwd: ws });
    await fs.writeFile(path.join(ws, "untracked.txt"), "x");

    const data = await gatherEnvSnapshotData(ws);
    expect(data!.gitDirtyCount).toBe(1);
  });

  it("超时预算极小时:工具链/git 为空,网络探测独立完成、显示不可达(不抛出、不挂起)", async () => {
    const data = await gatherEnvSnapshotData(ws, 1);
    expect(data).not.toBeNull();
    expect(data!.toolchain).toEqual([]);
    expect(data!.gitBranch).toBeNull();
    expect(data!.network?.reachable["npm registry"]).toBe(false);
    expect(data!.network?.reachable["PyPI"]).toBe(false);
  });

  it("不存在的目录:工具链/git 探测失败,网络探测仍独立完成、不抛出", async () => {
    const data = await gatherEnvSnapshotData(path.join(ws, "does-not-exist"));
    expect(data).not.toBeNull();
    expect(data!.toolchain).toEqual([]);
    expect(data!.gitBranch).toBeNull();
    expect(data!.network).not.toBeNull();
  });
});

describe("formatEnvSnapshot", () => {
  it("null 输入 → 空串", () => {
    expect(formatEnvSnapshot(null, false)).toBe("");
  });

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
});

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
    stubProxyEnvCleared();
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:7890");
    const result = await probeNetwork(50);
    expect(result.proxy).toBe("http://127.0.0.1:7890");
  });

  it("无代理变量 → proxy 为 null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    stubProxyEnvCleared();
    const result = await probeNetwork(50);
    expect(result.proxy).toBeNull();
  });
});
