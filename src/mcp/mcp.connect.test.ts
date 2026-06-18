import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolContext } from "../tools/types.js";
import { isConnError, unpack, connectMcpServers, type ElicitHandler } from "./mcp.js";

const FAKE = fileURLToPath(new URL("./__fixtures__/fake-mcp-server.mjs", import.meta.url));
const ctx = {} as ToolContext; // mcp handler 不读 ctx

describe("isConnError", () => {
  it("连接断裂类报错 → true(据此触发重连)", () => {
    for (const m of ["Connection closed", "transport closed", "write after end", "EPIPE", "ECONNRESET", "server terminated", "not connected", "broken pipe"]) {
      expect(isConnError(new Error(m))).toBe(true);
    }
  });
  it("普通工具错误 → false(不重连,避免掩盖真错)", () => {
    expect(isConnError(new Error("invalid arguments: msg required"))).toBe(false);
    expect(isConnError("boom")).toBe(false);
  });
});

describe("unpack", () => {
  it("拼接多个 text 块", () => {
    expect(unpack({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("a\nb");
  });
  it("非 text 块 → JSON 序列化保留", () => {
    expect(unpack({ content: [{ type: "image", data: "x" }] })).toContain("image");
  });
  it("空内容 → 占位串", () => {
    expect(unpack({ content: [] })).toBe("(无输出)");
    expect(unpack({})).toBe("(无输出)");
  });
});

describe("connectMcpServers(真实 stdio 子进程)", () => {
  it("连上 server:发现工具(mcp__<server>__<tool> 前缀)并能调用", async () => {
    const conn = await connectMcpServers({ mcpServers: { fake: { command: "node", args: [FAKE] } } });
    try {
      expect(conn.servers).toEqual([{ name: "fake", tools: 1, resources: 0, prompts: 0, ok: true }]);
      const echo = conn.tools.find((t) => t.name === "mcp__fake__echo");
      expect(echo).toBeTruthy();
      expect(echo!.capability).toBe("network");
      expect(await echo!.handler({ msg: "hi" }, ctx)).toBe("echo:hi");
    } finally {
      await conn.close();
    }
  }, 20000);

  it("单个 server 失败不影响其余(ok:false + error,且整体不抛)", async () => {
    const conn = await connectMcpServers({
      mcpServers: {
        bad: { command: "dao-no-such-cmd-xyz", args: [] },
        fake: { command: "node", args: [FAKE] },
      },
    });
    try {
      const bad = conn.servers.find((s) => s.name === "bad");
      const good = conn.servers.find((s) => s.name === "fake");
      expect(bad?.ok).toBe(false);
      expect(bad?.error).toBeTruthy();
      expect(good?.ok).toBe(true);
      expect(conn.tools.some((t) => t.name === "mcp__fake__echo")).toBe(true);
    } finally {
      await conn.close();
    }
  }, 20000);

  it("server 崩溃 → 自动重连重试一次并成功返回(P3-10 自愈)", async () => {
    const crashFile = path.join(mkdtempSync(path.join(os.tmpdir(), "dao-mcp-crash-")), "count");
    const conn = await connectMcpServers({
      mcpServers: {
        fake: { command: "node", args: [FAKE], env: { MCP_FAKE_CRASH_FILE: crashFile, MCP_FAKE_CRASH_ON: "0" } },
      },
    });
    try {
      const echo = conn.tools.find((t) => t.name === "mcp__fake__echo")!;
      // 第 0 次调用 server 崩溃 → isConnError → 重连新进程 → 第 1 次成功
      expect(await echo.handler({ msg: "alive" }, ctx)).toBe("echo:alive");
      // 坐实崩溃确实发生(非假绿):进程A 写 1 后崩,进程B 写 2 后返回 → 计数=2
      expect(readFileSync(crashFile, "utf8")).toBe("2");
    } finally {
      await conn.close();
    }
  }, 20000);
});

describe("connectMcpServers(resources / prompts / elicitation)", () => {
  const rich = (onElicit?: ElicitHandler) =>
    connectMcpServers(
      { mcpServers: { fake: { command: "node", args: [FAKE], env: { MCP_FAKE_RICH: "1" } } } },
      onElicit ? { onElicit } : undefined,
    );

  it("声明 resources/prompts 能力 → 合成 read_resource / get_prompt 工具,可用项写进描述,且能调用", async () => {
    const conn = await rich();
    try {
      const s = conn.servers.find((x) => x.name === "fake");
      expect(s).toMatchObject({ ok: true, tools: 2, resources: 1, prompts: 1 }); // 原始工具 echo + ask_name = 2
      const readRes = conn.tools.find((t) => t.name === "mcp__fake__read_resource")!;
      const getPrompt = conn.tools.find((t) => t.name === "mcp__fake__get_prompt")!;
      expect(readRes.description).toContain("mem://greeting"); // 可用 uri 写进描述供模型发现
      expect(getPrompt.description).toContain("greet");
      expect(await readRes.handler({ uri: "mem://greeting" }, ctx)).toBe("hello-resource");
      expect(await getPrompt.handler({ name: "greet", arguments: { who: "dao" } }, ctx)).toContain("say hi to dao");
    } finally {
      await conn.close();
    }
  }, 20000);

  it("elicitation:server 中途要输入 → 转 onElicit;accept 带 content 回灌 server", async () => {
    const conn = await rich(async () => ({ action: "accept", content: { name: "dao" } }));
    try {
      const askName = conn.tools.find((t) => t.name === "mcp__fake__ask_name")!;
      expect(await askName.handler({}, ctx)).toBe("hi dao");
    } finally {
      await conn.close();
    }
  }, 20000);

  it("elicitation:onElicit 婉拒 → server 侧收到 decline", async () => {
    const conn = await rich(async () => ({ action: "decline" }));
    try {
      const askName = conn.tools.find((t) => t.name === "mcp__fake__ask_name")!;
      expect(await askName.handler({}, ctx)).toBe("elicit:decline");
    } finally {
      await conn.close();
    }
  }, 20000);
});
