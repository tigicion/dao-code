import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LspClient } from "./client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", ".."); // 需要能解析到 node_modules/typescript
const FIXTURES = path.join(__dirname, "testfixtures");
const FILE = path.join(FIXTURES, "sample.ts"); // 提交进仓库的固定 fixture,只读操作用它

// 真实集成测试:用 typescript-language-server(npx 现拉,已在本机缓存过)当真正的 server——
// LSP 是协议敏感的东西,纯 mock 测不出初始化握手/位置编码这类容易出精细 bug 的地方。
// fixture 必须落在仓库目录树内(而非 os.tmpdir()),否则 server 沿目录向上找不到
// node_modules/typescript,握手会报"Could not find a valid TypeScript installation"。
describe.skipIf(process.env.CI === "1")("LspClient(真实 typescript-language-server)", () => {
  let client: LspClient;

  beforeAll(async () => {
    client = new LspClient("npx", ["--yes", "typescript-language-server", "--stdio"], pathToFileURL(REPO_ROOT).href);
  }, 60000);

  afterAll(async () => {
    client.dispose();
  });

  it("definition:在调用处(第4行 greet)跳到定义处(第1行)", async () => {
    // "export const msg = greet(\"dao\");" —— g 在第 20 个字符(1-based)。
    const out = await client.definition(FILE, 4, 20);
    expect(out).toContain("sample.ts:1:");
  }, 30000);

  it("references:在定义处查引用,应包含调用处第4行", async () => {
    const out = await client.references(FILE, 1, 17); // 函数名 greet 上
    expect(out).toContain("sample.ts:4:");
  }, 30000);

  it("hover:函数名上有类型信息", async () => {
    const out = await client.hover(FILE, 1, 17);
    expect(out.toLowerCase()).toContain("greet");
  }, 30000);

  it("documentSymbol:能列出 greet 和 msg 两个顶层符号", async () => {
    const out = await client.documentSymbol(FILE);
    expect(out).toContain("greet");
    expect(out).toContain("msg");
  }, 30000);

  it("workspaceSymbol:按名搜到 greet", async () => {
    const out = await client.workspaceSymbol("greet");
    expect(out).toContain("greet");
  }, 30000);

  it("implementation:接口 Greeter(第6行)找到实现类 EnglishGreeter(第9行)", async () => {
    // "export interface Greeter {" —— G 在第 18 个字符。
    const out = await client.implementation(FILE, 6, 18);
    expect(out).toContain("sample.ts:9:");
  }, 30000);

  it("prepareCallHierarchy:在函数上能建立调用层级条目", async () => {
    // "function inner(name: string): string {" —— i(nner) 在第 10 个字符。
    const out = await client.prepareCallHierarchy(FILE, 17, 10);
    expect(out).toContain("inner");
  }, 30000);

  it("incomingCalls:inner 的调用方包含 outer", async () => {
    const out = await client.incomingCalls(FILE, 17, 10);
    expect(out).toContain("outer");
  }, 30000);

  it("outgoingCalls:outer 调用了 inner", async () => {
    // "export function outer(name: string): string {" —— o(uter) 在第 17 个字符。
    const out = await client.outgoingCalls(FILE, 14, 17);
    expect(out).toContain("inner");
  }, 30000);

  it("编辑文件后重新查 definition,拿到的是新内容(不是打开时的旧快照)", async () => {
    // 独立 scratch 文件(不动提交进仓库的 fixture):开头插入一行空行,
    // greet 定义从第1行挪到第2行,调用处从第4行挪到第5行。
    const scratch = path.join(FIXTURES, "sample.scratch.ts");
    const original = await fs.readFile(FILE, "utf8");
    await fs.writeFile(scratch, original);
    try {
      await client.definition(scratch, 4, 20); // 先打开一次(旧内容)
      await fs.writeFile(scratch, "\n" + original);
      await new Promise((r) => setTimeout(r, 50)); // 确保 mtime 真的变了
      const out = await client.definition(scratch, 5, 20); // 挪动后调用处在第5行,字符位置不变
      expect(out).toContain("sample.scratch.ts:2:"); // 定义挪到第2行,证明 server 侧同步到了新内容
    } finally {
      await fs.rm(scratch, { force: true });
    }
  }, 30000);
});
