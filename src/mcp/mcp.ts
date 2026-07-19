import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ElicitRequestSchema, ToolListChangedNotificationSchema, PromptListChangedNotificationSchema, ResourceListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";

// MCP(Model Context Protocol)集成:连配置里的 MCP server,发现其工具/资源/提示并注册进工具表,
// 让 dao 能用生态里的 MCP server(GitHub/DB/浏览器等)。配置 .dao/mcp.json(Claude Desktop 同格式):
//   stdio:{ "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": {...} } }
//   http :{ "remote": { "type": "http", "url": "https://…/mcp", "headers": { "Authorization": "Bearer …" } } }
//   sse  :{ "remote": { "type": "sse",  "url": "https://…/sse" } }

export interface McpServerConfig {
  // -- stdio(本地子进程)--
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // -- http / sse(远程)--有 url 即走 HTTP;type:"sse" 用 SSE,否则 Streamable HTTP --
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
      /* 不存在/非法 -> 跳过 */
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

// server 状态(供 /mcp 命令展示)
export interface McpServerStatus {
  name: string;
  tools: number;
  resources: number;
  prompts: number;
  ok: boolean;
  disabled?: boolean;
  error?: string;
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

// disabled 状态持久化文件路径(~/.dao/mcp_state.json)。
async function loadDisabledSet(file: string): Promise<Set<string>> {
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as { disabled?: string[] };
    return new Set(raw.disabled ?? []);
  } catch { return new Set(); }
}
async function saveDisabledSet(file: string, set: Set<string>): Promise<void> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true }); // 全新环境 ~/.dao 可能还不存在,不建目录会静默写入失败
    await fs.writeFile(file, JSON.stringify({ disabled: [...set] }, null, 2));
  } catch { /* 写不了就算了 */ }
}

// 单个 server 的连接状态。
interface ServerHolder {
  client: Client;
  config: McpServerConfig;
  // 崩溃自愈:fn 抛连接错误 -> 关旧 client、重连、重试一次(holder.client 可替换)。
  call: <T>(fn: (c: Client) => Promise<T>) => Promise<T>;
}

// MCP 运行时管理器:取代旧的一次性 connectMcpServers,支持 toggle/reconnect/list_changed/add。
// 持有 ToolRegistry 引用,connect/disconnect 时自动 register/unregister 工具。
// MCP 工具默认 deferred(不进固定前缀 toolSummaries),toggle/reconnect 只改 ToolRegistry Map + activatedMcp,
// 不碰固定前缀 -- 前缀缓存安全。
export class McpManager {
  #holders = new Map<string, ServerHolder>();
  /** 已连接的 server 数(只读访问) */
  get connectedCount(): number { return this.#holders.size; }
  private get holders(): Map<string, ServerHolder> { return this.#holders; }
  private disabledSet = new Set<string>();
  private disabledFile: string;
  private config: McpConfig;
  private registry: ToolRegistry;
  private onElicit?: ElicitHandler;
  // 连接/断开时通知 index.ts 注入 system 消息(尾部,不碰前缀)。
  onServerChange?: (notice: string) => void;

  constructor(registry: ToolRegistry, config: McpConfig, opts?: { onElicit?: ElicitHandler; disabledFile?: string }) {
    this.registry = registry;
    this.config = config;
    this.onElicit = opts?.onElicit;
    this.disabledFile = opts?.disabledFile ?? path.join(process.env.HOME ?? "", ".dao", "mcp_state.json");
  }

  // 启动时连接所有配置的 server(跳过 disabled 的)。单个失败不影响其余。
  async init(): Promise<void> {
    this.disabledSet = await loadDisabledSet(this.disabledFile);
    for (const [name, sc] of Object.entries(this.config.mcpServers ?? {})) {
      if (this.disabledSet.has(name)) continue;
      await this.connectServer(name, sc).catch(() => {}); // 错误已记录在 status 里
    }
  }

  // 连接单个 server 并注册其工具。失败时记录状态但不抛。
  async connectServer(name: string, sc: McpServerConfig): Promise<void> {
    if (this.holders.has(name)) return; // 已连接
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
      const client = new Client({ name: "dao-code", version: "0.1.1" }, { capabilities: { elicitation: {} } });
      if (this.onElicit) {
        client.setRequestHandler(ElicitRequestSchema, async (req) => {
          const p = req.params as { message: string; requestedSchema?: Record<string, unknown> };
          const r = await this.onElicit!(p.message, p.requestedSchema ?? {});
          return r.content ? { action: r.action, content: r.content } : { action: r.action };
        });
      }
      await client.connect(makeTransport());
      return client;
    };

    const client = await makeClient();
    const holder: ServerHolder = { client, config: sc, call: async <T>(fn: (c: Client) => Promise<T>): Promise<T> => {
      try { return await fn(holder.client); } catch (e) {
        if (!isConnError(e)) throw e;
        try { await holder.client.close(); } catch { /* 已死 */ }
        holder.client = await makeClient();
        // 换了新 client,通知监听器要在新 client 上重新绑定——setupNotifications 之前只在
        // 首次 connectServer 时调用过一次,绑的是旧 client;不重新绑的话,这次自愈之后
        // server 端任何 list_changed 通知都不会再同步到 ToolRegistry,且没有任何报错提示。
        this.setupNotifications(name, holder);
        return await fn(holder.client);
      }
    }};

    // 先枚举工具再登记进 holders——枚举失败(握手成功但 listTools 抛错/返回异常格式)不留下
    // 半初始化的 holder。之前是握手一成功就 set 进 holders,枚举失败会被 init() 的 catch 吞掉,
    // 但 holder 已经在 map 里了,getServerStatus 会把它报成 ok:true/0 工具这种看似健康、实际
    // 已经坏掉的状态,而不是旧版 connectMcpServers 那种明确的 ok:false + 错误信息。
    let tools: Tool[];
    try {
      tools = await this.buildToolsForServer(name, holder);
    } catch (e) {
      try { await client.close(); } catch { /* 已死 */ }
      throw e;
    }
    this.holders.set(name, holder);
    for (const t of tools) this.registry.register(t);

    // 注册 list_changed 通知处理器
    this.setupNotifications(name, holder);
  }

  // 为一个 server 构建 dao 工具对象(含 tools/resources/prompts)。
  private async buildToolsForServer(name: string, holder: ServerHolder): Promise<Tool[]> {
    const tools: Tool[] = [];
    const { call, client } = holder;
    const caps = client.getServerCapabilities();

    // -- tools --
    const listed = await client.listTools();
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

    // -- resources --
    if (caps?.resources) {
      tools.push({
        name: `mcp__${name}__list_resources`,
        description: `列出 MCP server「${name}」当前暴露的全部 resource(uri + 名称,实时查询)。`,
        schema: z.object({}),
        apiParameters: { type: "object", properties: {} },
        capability: "network",
        approval: "suggest",
        handler: async () => {
          const r = await call((c) => c.listResources());
          const items = r.resources.map((x: { uri: string; name?: string }) => (x.name ? `${x.uri}(${x.name})` : x.uri));
          return items.length ? items.join("\n") : "(server 未列出任何 resource)";
        },
      });
      tools.push({
        name: `mcp__${name}__read_resource`,
        description: `读取 MCP server「${name}」的一个 resource(按 uri)。先用 mcp__${name}__list_resources 查可用 uri。`,
        schema: z.object({ uri: z.string() }),
        apiParameters: { type: "object", properties: { uri: { type: "string", description: "resource 的 uri" } }, required: ["uri"] },
        capability: "network",
        approval: "suggest",
        handler: async (args: { uri: string }) => unpackResource(await call((c) => c.readResource({ uri: args.uri }))),
      });
    }

    // -- prompts --
    if (caps?.prompts) {
      tools.push({
        name: `mcp__${name}__list_prompts`,
        description: `列出 MCP server「${name}」当前暴露的全部 prompt 模板(name + 说明,实时查询)。`,
        schema: z.object({}),
        apiParameters: { type: "object", properties: {} },
        capability: "network",
        approval: "suggest",
        handler: async () => {
          const r = await call((c) => c.listPrompts());
          const items = r.prompts.map((x: { name: string; description?: string }) => (x.description ? `${x.name}(${x.description})` : x.name));
          return items.length ? items.join("\n") : "(server 未列出任何 prompt)";
        },
      });
      tools.push({
        name: `mcp__${name}__get_prompt`,
        description: `取 MCP server「${name}」的 prompt 模板(按 name,可带 arguments 字符串映射)。先用 mcp__${name}__list_prompts 查可用 name。`,
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

    return tools;
  }

  // 注册 list_changed 通知处理器:server 端工具列表变化时自动同步到 ToolRegistry。
  private setupNotifications(name: string, holder: ServerHolder): void {
    const caps = holder.client.getServerCapabilities();
    const prefix = `mcp__${name}__`;

    if (caps?.tools?.listChanged) {
      holder.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        try {
          this.registry.unregisterByPrefix(prefix);
          const tools = await this.buildToolsForServer(name, holder);
          for (const t of tools) this.registry.register(t);
          this.onServerChange?.(`MCP server「${name}」工具列表已更新(当前 ${tools.length} 个工具)。`);
        } catch { /* 通知处理失败不影响会话 */ }
      });
    }
    if (caps?.prompts?.listChanged) {
      holder.client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
        // prompts 变化影响 list_prompts/get_prompt 工具,重建该 server 全部工具
        try {
          this.registry.unregisterByPrefix(prefix);
          const tools = await this.buildToolsForServer(name, holder);
          for (const t of tools) this.registry.register(t);
        } catch { /* */ }
      });
    }
    if (caps?.resources?.listChanged) {
      holder.client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
        try {
          this.registry.unregisterByPrefix(prefix);
          const tools = await this.buildToolsForServer(name, holder);
          for (const t of tools) this.registry.register(t);
        } catch { /* */ }
      });
    }
  }

  // 断开单个 server:从 ToolRegistry 移除其工具 + 关闭 client。
  async disconnectServer(name: string): Promise<void> {
    const holder = this.holders.get(name);
    if (!holder) return;
    this.registry.unregisterByPrefix(`mcp__${name}__`);
    try { await holder.client.close(); } catch { /* 已死 */ }
    this.holders.delete(name);
  }

  // 重连:断开旧连接 -> 重新连接 -> 注册新工具。
  async reconnect(name: string): Promise<void> {
    if (this.disabledSet.has(name)) {
      // 不检查的话,重连一个刚被 /mcp toggle 关掉的 server 会让它的工具重新注册进本次会话,
      // 但持久化的禁用状态没变——getServerStatus 还是报它禁用,下次启动又会被跳过连接,
      // 状态和实际行为对不上。
      this.onServerChange?.(`MCP server「${name}」当前是禁用状态,重连前请先用 /mcp toggle ${name} on 启用。`);
      return;
    }
    const holder = this.holders.get(name);
    const config = holder?.config ?? this.config.mcpServers?.[name];
    if (!config) throw new Error(`MCP server ${name} not found`);
    await this.disconnectServer(name);
    await this.connectServer(name, config);
    this.onServerChange?.(`MCP server「${name}」已重新连接。`);
  }

  // toggle enable/disable(持久化)。
  async toggle(name: string, on: boolean): Promise<void> {
    if (on) {
      this.disabledSet.delete(name);
      const config = this.config.mcpServers?.[name];
      if (config) await this.connectServer(name, config);
      this.onServerChange?.(`MCP server「${name}」已启用。`);
    } else {
      this.disabledSet.add(name);
      await this.disconnectServer(name);
      this.onServerChange?.(`MCP server「${name}」已禁用。`);
    }
    await saveDisabledSet(this.disabledFile, this.disabledSet);
  }

  // 运行时添加新 server:更新配置 + 连接 + 注册。
  async addServer(name: string, config: McpServerConfig, configFiles?: string[]): Promise<void> {
    this.config.mcpServers ??= {};
    this.config.mcpServers[name] = config;
    // 持久化到 mcp.json(写第一个可写文件)
    if (configFiles?.length) {
      try {
        const f = configFiles[0]!;
        const existing = JSON.parse(await fs.readFile(f, "utf8").catch(() => "{}")) as McpConfig;
        existing.mcpServers ??= {};
        existing.mcpServers[name] = config;
        await fs.writeFile(f, JSON.stringify(existing, null, 2));
      } catch { /* 持久化失败不阻塞连接 */ }
    }
    await this.connectServer(name, config);
    this.onServerChange?.(`MCP server「${name}」已添加并连接。`);
  }

  // 获取 server 状态列表(供 /mcp 命令展示)。
  getServerStatus(): McpServerStatus[] {
    const statuses: McpServerStatus[] = [];
    const allNames = new Set([...Object.keys(this.config.mcpServers ?? {}), ...this.holders.keys()]);
    for (const name of allNames) {
      const isDisabled = this.disabledSet.has(name);
      const holder = this.holders.get(name);
      if (isDisabled && !holder) {
        statuses.push({ name, tools: 0, resources: 0, prompts: 0, ok: false, disabled: true });
        continue;
      }
      if (!holder) {
        statuses.push({ name, tools: 0, resources: 0, prompts: 0, ok: false, error: "未连接" });
        continue;
      }
      const myTools = this.registry.countByPrefix(`mcp__${name}__`);
      statuses.push({ name, tools: myTools, resources: 0, prompts: 0, ok: true, disabled: false });
    }
    return statuses;
  }

  // 关闭全部连接。
  async close(): Promise<void> {
    for (const [name] of this.holders) {
      const holder = this.holders.get(name);
      try { await holder?.client.close(); } catch { /* 忽略 */ }
    }
    this.holders.clear();
  }

  // 兼容旧接口:返回类似旧 McpConnections 的结构。
  get tools(): Tool[] {
    // 不再维护独立的 tools 数组,工具直接注册在 ToolRegistry 里。
    // 这个 getter 只用于 index.ts 启动时判断是否有 MCP 工具(决定是否注册 ToolSearch)。
    return this.holders.size > 0 ? [{ name: "__mcp_placeholder__", description: "", schema: z.object({}), capability: "network", approval: "auto", handler: async () => "" }] : [];
  }
  get servers(): McpServerStatus[] {
    return this.getServerStatus();
  }
}

// 兼容旧接口:子代理一次性连接 MCP server 用(不管理生命周期,close 后即弃)。
// 主会话用 McpManager;子代理仍用这个一次性函数(连上 -> 取工具 -> close)。
export interface McpConnections {
  tools: Tool[];
  servers: McpServerStatus[];
  close: () => Promise<void>;
}

export async function connectMcpServers(config: McpConfig, opts?: { onElicit?: ElicitHandler }): Promise<McpConnections> {
  const holders: { client: Client }[] = [];
  const tools: Tool[] = [];
  const servers: McpServerStatus[] = [];

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
      const client = new Client({ name: "dao-code", version: "0.1.1" }, { capabilities: { elicitation: {} } });
      if (opts?.onElicit) {
        client.setRequestHandler(ElicitRequestSchema, async (req) => {
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
      const call = async <T>(fn: (c: Client) => Promise<T>): Promise<T> => {
        try { return await fn(holder.client); } catch (e) {
          if (!isConnError(e)) throw e;
          try { await holder.client.close(); } catch { /* 已死 */ }
          holder.client = await makeClient();
          return await fn(holder.client);
        }
      };

      const caps = holder.client.getServerCapabilities();
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

      let resourceCount = 0;
      if (caps?.resources) {
        const rl = await holder.client.listResources().catch(() => ({ resources: [] as Array<{ uri: string; name?: string }> }));
        resourceCount = rl.resources.length;
        tools.push({
          name: `mcp__${name}__list_resources`,
          description: `列出 MCP server「${name}」当前暴露的全部 resource(uri + 名称,实时查询)。`,
          schema: z.object({}),
          apiParameters: { type: "object", properties: {} },
          capability: "network",
          approval: "suggest",
          handler: async () => {
            const r = await call((c) => c.listResources());
            const items = r.resources.map((x: { uri: string; name?: string }) => (x.name ? `${x.uri}(${x.name})` : x.uri));
            return items.length ? items.join("\n") : "(server 未列出任何 resource)";
          },
        });
        tools.push({
          name: `mcp__${name}__read_resource`,
          description: `读取 MCP server「${name}」的一个 resource(按 uri)。先用 mcp__${name}__list_resources 查可用 uri。`,
          schema: z.object({ uri: z.string() }),
          apiParameters: { type: "object", properties: { uri: { type: "string", description: "resource 的 uri" } }, required: ["uri"] },
          capability: "network",
          approval: "suggest",
          handler: async (args: { uri: string }) => unpackResource(await call((c) => c.readResource({ uri: args.uri }))),
        });
      }

      let promptCount = 0;
      if (caps?.prompts) {
        const pl = await holder.client.listPrompts().catch(() => ({ prompts: [] as Array<{ name: string; description?: string }> }));
        promptCount = pl.prompts.length;
        tools.push({
          name: `mcp__${name}__list_prompts`,
          description: `列出 MCP server「${name}」当前暴露的全部 prompt 模板(name + 说明,实时查询)。`,
          schema: z.object({}),
          apiParameters: { type: "object", properties: {} },
          capability: "network",
          approval: "suggest",
          handler: async () => {
            const r = await call((c) => c.listPrompts());
            const items = r.prompts.map((x: { name: string; description?: string }) => (x.description ? `${x.name}(${x.description})` : x.name));
            return items.length ? items.join("\n") : "(server 未列出任何 prompt)";
          },
        });
        tools.push({
          name: `mcp__${name}__get_prompt`,
          description: `取 MCP server「${name}」的 prompt 模板(按 name,可带 arguments 字符串映射)。先用 mcp__${name}__list_prompts 查可用 name。`,
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
      for (const h of holders) { try { await h.client.close(); } catch { /* 忽略 */ } }
    },
  };
}