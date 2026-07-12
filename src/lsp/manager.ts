import { LspClient } from "./client.js";
import { resolveServerForFile, type LspConfig } from "./config.js";

// 按语言懒启动/复用 LspClient:同一语言的多次调用共享同一个已初始化的 server 进程
// (重新 spawn 一次 server + 走一遍 initialize 握手很慢,没必要每次调用都做)。
export class LspManager {
  private clients = new Map<string, LspClient>(); // server 名 -> 已启动的 client

  constructor(private config: LspConfig, private rootUri: string) {}

  // 找不到配置(该扩展名没配 server)返回 error 字符串;找到则懒启动/复用对应 client。
  resolve(filePath: string): { client: LspClient } | { error: string } {
    const found = resolveServerForFile(this.config, filePath);
    if (!found) {
      return { error: `没有为「${filePath}」这类文件配置 language server。在 .dao/lsp.json 里加一条(见 src/lsp/config.ts 顶部注释的格式示例)。` };
    }
    let client = this.clients.get(found.name);
    if (!client) {
      client = new LspClient(found.server.command, found.server.args ?? [], this.rootUri);
      this.clients.set(found.name, client);
    }
    return { client };
  }

  disposeAll(): void {
    for (const c of this.clients.values()) c.dispose();
    this.clients.clear();
  }
}
