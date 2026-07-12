import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from "vscode-jsonrpc/node";

// 通用 LSP 客户端:一个实例对应一个已启动的 language server 子进程。协议层(消息分帧/请求-响应关联)
// 交给 vscode-jsonrpc(微软官方维护、零依赖),这里只负责:初始化握手、文档同步(打开/变更时重新同步)、
// 位置编码转换(对外 1-based,行编辑器习惯,同 CC 的 LSP 工具接口;对 LSP 协议本身是 0-based)、
// 把响应整理成可读文本。不接入任何语言的二进制——command/args 完全来自用户配置(见 config.ts)。

// 对外 API 用 1-based line/character(同 read_file 的行号习惯、CC 的 LSP 工具接口一致);
// 发给 LSP 协议前统一在这里转 0-based,别让每个操作各自减一、容易漏。
function toLspPosition(line: number, character: number): { line: number; character: number } {
  return { line: line - 1, character: character - 1 };
}

function fmtLocation(loc: { uri: string; range: { start: { line: number; character: number } } }): string {
  const p = new URL(loc.uri).pathname;
  return `${p}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
}

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".jsx": "javascriptreact",
  ".mjs": "javascript", ".cjs": "javascript", ".py": "python", ".go": "go", ".rs": "rust",
  ".java": "java", ".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp", ".rb": "ruby", ".php": "php",
};
function languageIdFor(filePath: string): string {
  return EXT_TO_LANG[path.extname(filePath).toLowerCase()] ?? "plaintext";
}

interface OpenDoc { version: number; mtimeMs: number }

export class LspClient {
  private conn: MessageConnection;
  private child: ChildProcessWithoutNullStreams;
  private openDocs = new Map<string, OpenDoc>(); // uri -> 已打开文档的版本/同步基准
  private initPromise: Promise<void> | undefined;

  constructor(command: string, args: string[], private rootUri: string) {
    this.child = spawn(command, args, { stdio: "pipe" });
    // 进程/管道错误(如 dispose 杀了进程后还有排队的写入 → EPIPE)必须有监听器,否则是未捕获异常、
    // 能直接崩掉整个 dao 进程——这里只吞掉(dispose 之后的错误无意义,之前的错误由各请求自己的
    // catch/reject 表达)。
    this.child.on("error", () => {});
    this.child.stdin.on("error", () => {});
    this.child.stdout.on("error", () => {});
    this.conn = createMessageConnection(new StreamMessageReader(this.child.stdout), new StreamMessageWriter(this.child.stdin));
    this.conn.onError(() => {}); // 同上,连接层的错误也吞掉(不让它变成未处理的 promise rejection)
    this.conn.listen();
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await this.conn.sendRequest("initialize", {
          processId: process.pid,
          rootUri: this.rootUri,
          capabilities: {
            textDocument: {
              definition: {}, references: {}, hover: {}, documentSymbol: {},
              implementation: {}, callHierarchy: {},
            },
            workspace: { symbol: {} },
          },
        });
        this.conn.sendNotification("initialized", {});
      })();
    }
    await this.initPromise;
  }

  // 打开或同步一个文档:未打开过 → didOpen;已打开但磁盘内容变了(mtime 变化,如 dao 自己编辑过)
  // → didChange 全量同步(整篇内容,版本号自增)——防止 server 侧看到的还是编辑前的旧内容。
  private async ensureSynced(filePath: string): Promise<string> {
    const abs = path.resolve(filePath);
    const uri = pathToFileURL(abs).href;
    const st = await fs.stat(abs);
    const existing = this.openDocs.get(uri);
    if (!existing) {
      const text = await fs.readFile(abs, "utf8");
      this.conn.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId: languageIdFor(abs), version: 1, text },
      });
      this.openDocs.set(uri, { version: 1, mtimeMs: st.mtimeMs });
    } else if (existing.mtimeMs !== st.mtimeMs) {
      const text = await fs.readFile(abs, "utf8");
      const version = existing.version + 1;
      this.conn.sendNotification("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }], // 无 range = 整篇替换,最简单也最不容易算错
      });
      this.openDocs.set(uri, { version, mtimeMs: st.mtimeMs });
    }
    return uri;
  }

  private async prep(filePath: string, line: number, character: number) {
    await this.ensureInitialized();
    const uri = await this.ensureSynced(filePath);
    return { textDocument: { uri }, position: toLspPosition(line, character) };
  }

  async definition(filePath: string, line: number, character: number): Promise<string> {
    const res = await this.conn.sendRequest("textDocument/definition", await this.prep(filePath, line, character));
    return this.formatLocations(res, "未找到定义");
  }

  async references(filePath: string, line: number, character: number): Promise<string> {
    const params = { ...(await this.prep(filePath, line, character)), context: { includeDeclaration: true } };
    const res = await this.conn.sendRequest("textDocument/references", params);
    return this.formatLocations(res, "未找到引用");
  }

  async implementation(filePath: string, line: number, character: number): Promise<string> {
    const res = await this.conn.sendRequest("textDocument/implementation", await this.prep(filePath, line, character));
    return this.formatLocations(res, "未找到实现");
  }

  async hover(filePath: string, line: number, character: number): Promise<string> {
    const res = (await this.conn.sendRequest("textDocument/hover", await this.prep(filePath, line, character))) as
      { contents?: string | { value?: string } | Array<string | { value?: string }> } | null;
    if (!res?.contents) return "(无 hover 信息)";
    const c = res.contents;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : x.value ?? "")).join("\n");
    return c.value ?? "(无 hover 信息)";
  }

  async documentSymbol(filePath: string): Promise<string> {
    await this.ensureInitialized();
    const uri = await this.ensureSynced(filePath);
    // 响应有两种形状(server 各自选一种):DocumentSymbol(层级,range 直接在对象上,可有 children)
    // 或 SymbolInformation(扁平,range 在 location.range 里)——都要认。
    interface DocSym { name: string; range?: { start: { line: number; character: number } }; location?: { range: { start: { line: number; character: number } } }; children?: DocSym[] }
    const res = (await this.conn.sendRequest("textDocument/documentSymbol", { textDocument: { uri } })) as DocSym[] | null;
    if (!res?.length) return "(无符号)";
    const lines: string[] = [];
    const walk = (syms: DocSym[], depth: number) => {
      for (const s of syms) {
        const start = s.range?.start ?? s.location?.range.start;
        if (start) lines.push(`${"  ".repeat(depth)}${s.name}  (行 ${start.line + 1})`);
        if (s.children?.length) walk(s.children, depth + 1);
      }
    };
    walk(res, 0);
    return lines.join("\n");
  }

  async workspaceSymbol(query: string): Promise<string> {
    await this.ensureInitialized();
    const res = (await this.conn.sendRequest("workspace/symbol", { query })) as
      Array<{ name: string; location: { uri: string; range: { start: { line: number; character: number } } } }> | null;
    if (!res?.length) return `未找到匹配「${query}」的符号`;
    return res.map((s) => `${s.name}  ${fmtLocation(s.location)}`).join("\n");
  }

  private async prepareCallHierarchyItem(filePath: string, line: number, character: number) {
    const items = (await this.conn.sendRequest("textDocument/prepareCallHierarchy", await this.prep(filePath, line, character))) as
      Array<Record<string, unknown>> | null;
    return items?.[0];
  }

  async prepareCallHierarchy(filePath: string, line: number, character: number): Promise<string> {
    const item = await this.prepareCallHierarchyItem(filePath, line, character);
    if (!item) return "(该位置无法建立调用层级——需是函数/方法)";
    return JSON.stringify(item);
  }

  async incomingCalls(filePath: string, line: number, character: number): Promise<string> {
    const item = await this.prepareCallHierarchyItem(filePath, line, character);
    if (!item) return "(该位置无法建立调用层级——需是函数/方法)";
    const res = (await this.conn.sendRequest("callHierarchy/incomingCalls", { item })) as
      Array<{ from: { name: string; uri: string; range: { start: { line: number; character: number } } } }> | null;
    if (!res?.length) return "(没有调用方)";
    return res.map((c) => `${c.from.name}  ${fmtLocation(c.from)}`).join("\n");
  }

  async outgoingCalls(filePath: string, line: number, character: number): Promise<string> {
    const item = await this.prepareCallHierarchyItem(filePath, line, character);
    if (!item) return "(该位置无法建立调用层级——需是函数/方法)";
    const res = (await this.conn.sendRequest("callHierarchy/outgoingCalls", { item })) as
      Array<{ to: { name: string; uri: string; range: { start: { line: number; character: number } } } }> | null;
    if (!res?.length) return "(没有被调用方)";
    return res.map((c) => `${c.to.name}  ${fmtLocation(c.to)}`).join("\n");
  }

  private formatLocations(res: unknown, emptyMsg: string): string {
    const arr = Array.isArray(res) ? res : res ? [res] : [];
    if (arr.length === 0) return emptyMsg;
    return (arr as Array<{ uri: string; range: { start: { line: number; character: number } } } | { targetUri: string; targetRange: { start: { line: number; character: number } } }>)
      .map((l) => ("uri" in l ? fmtLocation(l) : fmtLocation({ uri: l.targetUri, range: l.targetRange })))
      .join("\n");
  }

  dispose(): void {
    // sendNotification 返回 Promise——同步 try/catch 抓不住之后才 reject 的情况(如管道已关导致
    // EPIPE),必须显式 .catch,否则是未处理的 promise rejection。
    try { this.conn.sendNotification("exit").catch(() => {}); } catch { /* 已关闭 */ }
    try { this.conn.dispose(); } catch { /* 忽略 */ }
    try { this.child.kill(); } catch { /* 忽略 */ }
  }
}
