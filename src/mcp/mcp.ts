import { promises as fs } from "node:fs";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "../tools/types.js";

// MCP(Model Context Protocol)集成:连配置里的 MCP server(stdio),发现其工具并注册进工具表,
// 让 dao 能用生态里的 MCP server(GitHub/DB/浏览器等)。配置 .codeds/mcp.json(Claude Desktop 同格式):
// { "mcpServers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": {...} } } }

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
export interface McpConfig {
  mcpServers?: Record<string, McpServerConfig>;
}

export async function loadMcpConfig(files: string[]): Promise<McpConfig> {
  const servers: Record<string, McpServerConfig> = {};
  for (const f of files) {
    try {
      const cfg = JSON.parse(await fs.readFile(f, "utf8")) as McpConfig;
      Object.assign(servers, cfg.mcpServers ?? {});
    } catch {
      /* 不存在/非法 → 跳过 */
    }
  }
  return { mcpServers: servers };
}

export interface McpConnections {
  tools: Tool[];
  servers: { name: string; tools: number; ok: boolean; error?: string }[];
  close: () => Promise<void>;
}

// 连接所有配置的 MCP server,返回其工具(名字前缀 mcp__<server>__<tool>)。单个 server 失败不影响其余。
export async function connectMcpServers(config: McpConfig): Promise<McpConnections> {
  const clients: Client[] = [];
  const tools: Tool[] = [];
  const servers: McpConnections["servers"] = [];
  for (const [name, sc] of Object.entries(config.mcpServers ?? {})) {
    try {
      const client = new Client({ name: "dao-code", version: "0.1.1" }, { capabilities: {} });
      const transport = new StdioClientTransport({
        command: sc.command,
        args: sc.args ?? [],
        env: { ...(process.env as Record<string, string>), ...(sc.env ?? {}) },
      });
      await client.connect(transport);
      const listed = await client.listTools();
      for (const t of listed.tools) {
        tools.push({
          name: `mcp__${name}__${t.name}`,
          description: t.description ?? `MCP ${name} 工具 ${t.name}`,
          schema: z.record(z.unknown()),
          apiParameters: (t.inputSchema as object) ?? { type: "object", properties: {} },
          capability: "network",
          approval: "suggest",
          handler: async (args: Record<string, unknown>) => {
            const res = await client.callTool({ name: t.name, arguments: args });
            const content = (res.content as Array<{ type: string; text?: string }>) ?? [];
            const text = content.map((c) => (c.type === "text" ? (c.text ?? "") : JSON.stringify(c))).join("\n").trim();
            return text || "(无输出)";
          },
        });
      }
      clients.push(client);
      servers.push({ name, tools: listed.tools.length, ok: true });
    } catch (e) {
      servers.push({ name, tools: 0, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return {
    tools,
    servers,
    close: async () => {
      for (const c of clients) {
        try {
          await c.close();
        } catch {
          /* 忽略关闭错误 */
        }
      }
    },
  };
}
