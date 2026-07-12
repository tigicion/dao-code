import { promises as fs } from "node:fs";
import path from "node:path";

// LSP 集成不接入任何语言的 server 二进制——纯协议客户端 + 用户自己配"扩展名→server 命令"的映射
// (同 diagnostics.ts 的 DAO_DIAGNOSTICS_CMD 思路,只是这里是双向协议)。没配置的文件类型直接报错,
// 不负责帮用户装好每种语言的 server。配置文件 .dao/lsp.json(用户级 ~/.dao/lsp.json 优先级更低,
// 项目级覆盖同名 server):
//   { "servers": { "typescript": { "command": "typescript-language-server", "args": ["--stdio"],
//                                   "extensions": [".ts", ".tsx"] } } }

export interface LspServerConfig {
  command: string;
  args?: string[];
  extensions: string[];
}
export interface LspConfig {
  servers?: Record<string, LspServerConfig>;
}

export async function loadLspConfig(files: string[]): Promise<LspConfig> {
  const servers: Record<string, LspServerConfig> = {};
  for (const f of files) {
    try {
      const cfg = JSON.parse(await fs.readFile(f, "utf8")) as LspConfig;
      Object.assign(servers, cfg.servers ?? {});
    } catch {
      /* 不存在/非法 → 跳过 */
    }
  }
  return { servers };
}

// 按文件扩展名找配的 server(找不到就是没配置,调用方据此报错——不静默兜底成某个默认值)。
export function resolveServerForFile(config: LspConfig, filePath: string): { name: string; server: LspServerConfig } | undefined {
  const ext = path.extname(filePath).toLowerCase();
  for (const [name, server] of Object.entries(config.servers ?? {})) {
    if (server.extensions.some((e) => e.toLowerCase() === ext)) return { name, server };
  }
  return undefined;
}
