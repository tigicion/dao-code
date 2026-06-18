import { promises as fs } from "node:fs";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "../tools/types.js";

// MCP(Model Context Protocol)集成:连配置里的 MCP server(stdio),发现其工具并注册进工具表,
// 让 dao 能用生态里的 MCP server(GitHub/DB/浏览器等)。配置 .dao/mcp.json(Claude Desktop 同格式):
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

// 连接错误(stdio server 崩了/管道断了):据此触发重连。普通工具错误不重连(避免掩盖)。
export function isConnError(e: unknown): boolean {
  const m = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /closed|not connected|disconnected|EPIPE|ECONNRESET|terminated|write after end|broken pipe|transport/i.test(m);
}

export function unpack(res: unknown): string {
  const content = ((res as { content?: unknown })?.content as Array<{ type: string; text?: string }>) ?? [];
  const text = content.map((c) => (c.type === "text" ? (c.text ?? "") : JSON.stringify(c))).join("\n").trim();
  return text || "(无输出)";
}

// 连接所有配置的 MCP server,返回其工具(名字前缀 mcp__<server>__<tool>)。单个 server 失败不影响其余。
// P3-10:stdio server 崩溃后,工具调用会自动重连一次再重试(holder.client 可替换)。
export async function connectMcpServers(config: McpConfig): Promise<McpConnections> {
  const holders: { client: Client }[] = [];
  const tools: Tool[] = [];
  const servers: McpConnections["servers"] = [];
  for (const [name, sc] of Object.entries(config.mcpServers ?? {})) {
    const makeClient = async (): Promise<Client> => {
      const client = new Client({ name: "dao-code", version: "0.1.1" }, { capabilities: {} });
      const transport = new StdioClientTransport({
        command: sc.command,
        args: sc.args ?? [],
        env: { ...(process.env as Record<string, string>), ...(sc.env ?? {}) },
      });
      await client.connect(transport);
      return client;
    };
    try {
      const holder = { client: await makeClient() };
      const listed = await holder.client.listTools();
      for (const t of listed.tools) {
        tools.push({
          name: `mcp__${name}__${t.name}`,
          description: t.description ?? `MCP ${name} 工具 ${t.name}`,
          schema: z.record(z.unknown()),
          apiParameters: (t.inputSchema as object) ?? { type: "object", properties: {} },
          capability: "network",
          approval: "suggest",
          handler: async (args: Record<string, unknown>) => {
            try {
              return unpack(await holder.client.callTool({ name: t.name, arguments: args }));
            } catch (e) {
              if (!isConnError(e)) throw e; // 普通工具错误:原样上抛
              // 连接断了 → 重连一次再重试(server 崩溃自愈)。
              try { await holder.client.close(); } catch { /* 已死 */ }
              holder.client = await makeClient();
              return unpack(await holder.client.callTool({ name: t.name, arguments: args }));
            }
          },
        });
      }
      holders.push(holder);
      servers.push({ name, tools: listed.tools.length, ok: true });
    } catch (e) {
      servers.push({ name, tools: 0, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return {
    tools,
    servers,
    close: async () => {
      for (const h of holders) {
        try { await h.client.close(); } catch { /* 忽略关闭错误 */ }
      }
    },
  };
}
