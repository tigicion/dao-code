import { describe, it, expect } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ToolContext } from "../tools/types.js";
import { connectMcpServers } from "./mcp.js";

const ctx = {} as ToolContext;

// 进程内起一个 Streamable HTTP 的 MCP server,返回其 url 与关闭器。用来测 dao 的 HTTP 传输路径(真往返)。
async function startHttpMcp(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = new McpServer({ name: "http-fake", version: "0.0.1" });
  server.registerTool(
    "echo",
    { description: "回显 msg", inputSchema: { msg: z.string() } },
    async ({ msg }) => ({ content: [{ type: "text", text: `http-echo:${msg}` }] }),
  );
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await server.connect(transport);

  const httpServer = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
  });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", () => r()));
  const port = (httpServer.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () => {
      await transport.close().catch(() => {});
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
}

describe("connectMcpServers(HTTP 传输)", () => {
  it("type:http + url → Streamable HTTP 连接、发现工具、调用(真往返)", async () => {
    const srv = await startHttpMcp();
    const conn = await connectMcpServers({ mcpServers: { remote: { type: "http", url: srv.url } } });
    try {
      expect(conn.servers.find((s) => s.name === "remote")).toMatchObject({ ok: true, tools: 1 });
      const echo = conn.tools.find((t) => t.name === "mcp__remote__echo")!;
      expect(await echo.handler({ msg: "hi" }, ctx)).toBe("http-echo:hi");
    } finally {
      await conn.close();
      await srv.close();
    }
  }, 20000);

  it("连不上的 HTTP server → ok:false + error,不抛、不影响启动", async () => {
    // 端口 1 必然连不上;证明走的是 HTTP 路径(失败被捕获为 server 级 error)。
    const conn = await connectMcpServers({ mcpServers: { dead: { type: "http", url: "http://127.0.0.1:1/mcp" } } });
    try {
      const s = conn.servers.find((x) => x.name === "dead");
      expect(s?.ok).toBe(false);
      expect(s?.error).toBeTruthy();
    } finally {
      await conn.close();
    }
  }, 20000);
});
