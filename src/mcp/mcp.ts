import { promises as fs } from "node:fs";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "../tools/types.js";

// MCP(Model Context Protocol)集成:连配置里的 MCP server,发现其工具/资源/提示并注册进工具表,
// 让 dao 能用生态里的 MCP server(GitHub/DB/浏览器等)。配置 .dao/mcp.json(Claude Desktop 同格式):
//   stdio:{ "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": {...} } }
//   http :{ "remote": { "type": "http", "url": "https://…/mcp", "headers": { "Authorization": "Bearer …" } } }
//   sse  :{ "remote": { "type": "sse",  "url": "https://…/sse" } }

export interface McpServerConfig {
  // —— stdio(本地子进程)——
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // —— http / sse(远程)——有 url 即走 HTTP;type:"sse" 用 SSE,否则 Streamable HTTP ——
  type?: "stdio" | "http" | "sse";
  url?: string;
  headers?: Record<string, string>;
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

// elicitation:server 中途要用户提供结构化输入。dao 把它转给 onElicit 回调(接 ask 层);未提供则婉拒。
export interface ElicitResponse {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}
export type ElicitHandler = (message: string, requestedSchema: Record<string, unknown>) => Promise<ElicitResponse>;

export interface McpConnections {
  tools: Tool[];
  servers: { name: string; tools: number; resources: number; prompts: number; ok: boolean; error?: string }[];
  close: () => Promise<void>;
}

// 连接错误(server 崩了/管道断了):据此触发重连。普通工具错误不重连(避免掩盖)。
export function isConnError(e: unknown): boolean {
  const m = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /closed|not connected|disconnected|EPIPE|ECONNRESET|terminated|write after end|broken pipe|transport/i.test(m);
}

// 工具结果:content[] 里的 text 拼接;非 text 块 JSON 化保留。
export function unpack(res: unknown): string {
  const content = ((res as { content?: unknown })?.content as Array<{ type: string; text?: string }>) ?? [];
  const text = content.map((c) => (c.type === "text" ? (c.text ?? "") : JSON.stringify(c))).join("\n").trim();
  return text || "(无输出)";
}

// resource 读取结果:contents[] 里的 text 拼接;二进制(blob)标注 mime,不倒进上下文。
export function unpackResource(res: unknown): string {
  const contents = ((res as { contents?: unknown })?.contents as Array<{ uri?: string; text?: string; blob?: string; mimeType?: string }>) ?? [];
  const parts = contents.map((c) => (c.text != null ? c.text : c.blob != null ? `[二进制内容 ${c.mimeType ?? "?"}${c.uri ? ` @ ${c.uri}` : ""}]` : ""));
  return parts.join("\n").trim() || "(无内容)";
}

// prompt 模板渲染结果:messages[] 渲染成「role: text」。
export function unpackPrompt(res: unknown): string {
  const messages = ((res as { messages?: unknown })?.messages as Array<{ role?: string; content?: { type?: string; text?: string } }>) ?? [];
  const lines = messages.map((m) => `${m.role ?? "?"}: ${m.content?.type === "text" ? (m.content.text ?? "") : JSON.stringify(m.content)}`);
  return lines.join("\n").trim() || "(空模板)";
}

// 截断 server 暴露项列表,塞进工具描述供模型发现(别让一长串 uri 把描述撑爆)。
function summarizeList(items: string[], max = 12): string {
  if (items.length === 0) return "(server 未列出任何项)";
  const shown = items.slice(0, max);
  return shown.join(" · ") + (items.length > max ? ` …(共 ${items.length} 项)` : "");
}

// 连接所有配置的 MCP server,返回其工具(名字前缀 mcp__<server>__<tool>)。单个 server 失败不影响其余。
// 重连自愈:server 崩溃后,任何调用(工具/资源/提示)会自动重连一次再重试(holder.client 可替换)。
export async function connectMcpServers(config: McpConfig, opts?: { onElicit?: ElicitHandler }): Promise<McpConnections> {
  const holders: { client: Client }[] = [];
  const tools: Tool[] = [];
  const servers: McpConnections["servers"] = [];

  for (const [name, sc] of Object.entries(config.mcpServers ?? {})) {
    const makeTransport = (): Transport => {
      if (sc.url) {
        const u = new URL(sc.url);
        const reqInit = sc.headers ? { requestInit: { headers: sc.headers } } : undefined;
        return sc.type === "sse" ? new SSEClientTransport(u, reqInit) : new StreamableHTTPClientTransport(u, reqInit);
      }
      return new StdioClientTransport({
        command: sc.command ?? "",
        args: sc.args ?? [],
        env: { ...(process.env as Record<string, string>), ...(sc.env ?? {}) },
      });
    };
    const makeClient = async (): Promise<Client> => {
      // 声明 elicitation 能力,server 才会向我们发起 elicitation/create。
      const client = new Client({ name: "dao-code", version: "0.1.1" }, { capabilities: { elicitation: {} } });
      if (opts?.onElicit) {
        client.setRequestHandler(ElicitRequestSchema, async (req) => {
          // params 是 form/url 两种模式的联合;message 两者都有,requestedSchema 仅 form 模式有。
          const p = req.params as { message: string; requestedSchema?: Record<string, unknown> };
          const r = await opts.onElicit!(p.message, p.requestedSchema ?? {});
          return r.content ? { action: r.action, content: r.content } : { action: r.action };
        });
      }
      await client.connect(makeTransport());
      return client;
    };

    try {
      const holder = { client: await makeClient() };
      // 崩溃自愈:fn 抛连接错误 → 关旧 client、重连、重试一次。
      const call = async <T>(fn: (c: Client) => Promise<T>): Promise<T> => {
        try {
          return await fn(holder.client);
        } catch (e) {
          if (!isConnError(e)) throw e; // 普通错误原样上抛
          try { await holder.client.close(); } catch { /* 已死 */ }
          holder.client = await makeClient();
          return await fn(holder.client);
        }
      };

      const caps = holder.client.getServerCapabilities();

      // —— tools ——
      const listed = await holder.client.listTools();
      for (const t of listed.tools) {
        tools.push({
          name: `mcp__${name}__${t.name}`,
          description: t.description ?? `MCP ${name} 工具 ${t.name}`,
          schema: z.record(z.unknown()),
          apiParameters: (t.inputSchema as object) ?? { type: "object", properties: {} },
          capability: "network",
          approval: "suggest",
          handler: async (args: Record<string, unknown>) => unpack(await call((c) => c.callTool({ name: t.name, arguments: args }))),
        });
      }

      // —— resources(若 server 声明 resources 能力)——合成一个 read_resource 工具,可用 uri 写进描述。
      let resourceCount = 0;
      if (caps?.resources) {
        const rl = await holder.client.listResources().catch(() => ({ resources: [] as Array<{ uri: string; name?: string }> }));
        resourceCount = rl.resources.length;
        const avail = summarizeList(rl.resources.map((r) => (r.name ? `${r.uri}(${r.name})` : r.uri)));
        tools.push({
          name: `mcp__${name}__read_resource`,
          description: `读取 MCP server「${name}」暴露的 resource(按 uri)。可用:${avail}`,
          schema: z.object({ uri: z.string() }),
          apiParameters: { type: "object", properties: { uri: { type: "string", description: "resource 的 uri" } }, required: ["uri"] },
          capability: "network",
          approval: "suggest",
          handler: async (args: { uri: string }) => unpackResource(await call((c) => c.readResource({ uri: args.uri }))),
        });
      }

      // —— prompts(若 server 声明 prompts 能力)——合成一个 get_prompt 工具,可用 name 写进描述。
      let promptCount = 0;
      if (caps?.prompts) {
        const pl = await holder.client.listPrompts().catch(() => ({ prompts: [] as Array<{ name: string; description?: string }> }));
        promptCount = pl.prompts.length;
        const avail = summarizeList(pl.prompts.map((p) => (p.description ? `${p.name}(${p.description})` : p.name)));
        tools.push({
          name: `mcp__${name}__get_prompt`,
          description: `取 MCP server「${name}」的 prompt 模板(按 name,可带 arguments 字符串映射)。可用:${avail}`,
          schema: z.object({ name: z.string(), arguments: z.record(z.string()).optional() }),
          apiParameters: {
            type: "object",
            properties: { name: { type: "string" }, arguments: { type: "object", description: "模板参数(字符串映射)" } },
            required: ["name"],
          },
          capability: "network",
          approval: "suggest",
          handler: async (args: { name: string; arguments?: Record<string, string> }) =>
            unpackPrompt(await call((c) => c.getPrompt({ name: args.name, arguments: args.arguments ?? {} }))),
        });
      }

      holders.push(holder);
      servers.push({ name, tools: listed.tools.length, resources: resourceCount, prompts: promptCount, ok: true });
    } catch (e) {
      servers.push({ name, tools: 0, resources: 0, prompts: 0, ok: false, error: e instanceof Error ? e.message : String(e) });
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
