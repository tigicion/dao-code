import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpManager } from "./mcp.js";
import { ToolRegistry } from "../tools/registry.js";

const FAKE = fileURLToPath(new URL("./__fixtures__/fake-mcp-server.mjs", import.meta.url));

describe("McpManager.toggle — 持久化", () => {
  it("disabledFile 所在目录不存在时,toggle 仍能把文件写下来(不静默丢失)", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dao-mcp-mgr-"));
    const disabledFile = path.join(dir, "nested", "does", "not", "exist", "mcp_state.json");
    expect(existsSync(path.dirname(disabledFile))).toBe(false);
    const registry = new ToolRegistry();
    const mgr = new McpManager(registry, { mcpServers: {} }, { disabledFile });
    await mgr.toggle("some-server", false); // 关闭一个甚至没配置的 server 名字也应该能持久化状态
    expect(existsSync(disabledFile)).toBe(true);
    const saved = JSON.parse(readFileSync(disabledFile, "utf8")) as { disabled: string[] };
    expect(saved.disabled).toContain("some-server");
  });
});

describe("McpManager.reconnect — 尊重 disabledSet", () => {
  it("对已禁用的 server 调用 reconnect,不重新连接、也不抛错,只提示先启用", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dao-mcp-mgr-"));
    const disabledFile = path.join(dir, "mcp_state.json");
    const registry = new ToolRegistry();
    const mgr = new McpManager(registry, { mcpServers: { fake: { command: "node", args: [FAKE] } } }, { disabledFile });
    const notices: string[] = [];
    mgr.onServerChange = (n) => notices.push(n);
    await mgr.toggle("fake", false); // 显式禁用(此时甚至还没连接过)
    await expect(mgr.reconnect("fake")).resolves.toBeUndefined(); // 不抛错
    expect(mgr.getServerStatus().find((s) => s.name === "fake")?.disabled).toBe(true); // 仍然是禁用状态
    expect(notices.some((n) => n.includes("禁用状态"))).toBe(true); // 给了明确提示,不是静默什么都不做
  });

  it("对话正常(未禁用)的 server 调用 reconnect,行为不变,能正常重连", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dao-mcp-mgr-"));
    const disabledFile = path.join(dir, "mcp_state.json");
    const registry = new ToolRegistry();
    const mgr = new McpManager(registry, { mcpServers: { fake: { command: "node", args: [FAKE] } } }, { disabledFile });
    try {
      await mgr.init();
      expect(registry.get("mcp__fake__echo")).toBeDefined();
      await mgr.reconnect("fake");
      expect(registry.get("mcp__fake__echo")).toBeDefined(); // 重连后工具还在
      expect(mgr.getServerStatus().find((s) => s.name === "fake")?.ok).toBe(true);
    } finally {
      await mgr.close();
    }
  }, 20000);
});

describe("McpManager.connectServer — 崩溃自愈后仍可用(回归,不破坏已有能力)", () => {
  it("server 崩溃一次 -> call() 自动重连重试并成功,重连后的工具调用仍正常工作", async () => {
    const crashFile = path.join(mkdtempSync(path.join(os.tmpdir(), "dao-mcp-mgr-crash-")), "count");
    const dir = mkdtempSync(path.join(os.tmpdir(), "dao-mcp-mgr-"));
    const disabledFile = path.join(dir, "mcp_state.json");
    const registry = new ToolRegistry();
    const mgr = new McpManager(
      registry,
      { mcpServers: { fake: { command: "node", args: [FAKE], env: { MCP_FAKE_CRASH_FILE: crashFile, MCP_FAKE_CRASH_ON: "0" } } } },
      { disabledFile },
    );
    try {
      await mgr.init();
      const echo = registry.get("mcp__fake__echo")!;
      expect(await echo.handler({ msg: "alive" }, { workspaceRoot: "/tmp" })).toBe("echo:alive");
      expect(readFileSync(crashFile, "utf8")).toBe("2"); // 坐实真的崩过一次,不是假绿
      // 自愈后 server 状态应该仍然汇报健康(不是残留成半初始化的坏状态)
      expect(mgr.getServerStatus().find((s) => s.name === "fake")?.ok).toBe(true);
    } finally {
      await mgr.close();
    }
  }, 20000);
});
