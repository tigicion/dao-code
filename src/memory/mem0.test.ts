import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openSqlite } from "../session/sqlite.js";
import { validateMemory } from "./validate.js";
import { buildMemorySection } from "./inject.js";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMem0Client, Mem0MemoryBackend } from "./mem0.js";
import { newMemory } from "./types.js";
import { memoryReadTool } from "../tools/memory_read.js";
import { memoryWriteTool } from "../tools/memory_write.js";
import { applyCorrections, applyConfirmed } from "../agent/reflect_persist.js";
import { FileMemoryBackend, disabledMemoryBackend, memoryDirs, memoryProjectId } from "./backend.js";
import { importFileMemories } from "./migrate.js";
import { createMemoryBackend, expandMemoryEnv } from "./config.js";

let root: string;
let server: Server;
let baseURL: string;
let embeddingCalls = 0;
let otherCalls = 0;
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "dao-mem0-"));
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.url !== "/embeddings") { otherCalls++; res.writeHead(500).end(); return; }
    embeddingCalls++;
    const input = JSON.parse(raw).input;
    // 固定的同义词向量,验证真实 SDK 的持久化/过滤/召回,不调用外部模型。
    const vector = (text: string) => /简洁|简短|concise/.test(text) ? [1, 0, 0] : [0, 1, 0];
    const inputs = Array.isArray(input) ? input : [input];
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: inputs.map((t: string, index: number) => ({ object: "embedding", index, embedding: vector(t) })), usage: { prompt_tokens: 1, total_tokens: 1 } }));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});
const fact = (name: string, text: string, type: "user" | "semantic" = "user") => newMemory({ name, title: name, text, type, today: "2026-10-26", confidence: 0.9 });
async function backend(db: string, user = "alice", project = "project-a") {
  const client = await createMem0Client({
    embedder: { provider: "openai", config: { apiKey: "test", model: "test", baseURL } },
    llm: { provider: "openai", config: { apiKey: "test", model: "unused", baseURL } },
    vectorStore: { provider: "memory", config: { dbPath: path.join(root, `${db}.db`), dimension: 3 } },
    historyStore: { provider: "sqlite", config: { historyDbPath: path.join(root, `${db}-history.db`) } },
  });
  return new Mem0MemoryBackend(client, user, project);
}

describe("Mem0 开源真实 SDK 接线", () => {
  it("持久化后重新打开,按语义召回全文,用户共享但项目/身份隔离", async () => {
    const a = await backend("isolation");
    await a.put(fact("表达偏好", "用户要求回答简洁"), "user");
    await a.put(fact("部署", "项目 A 使用专用集群", "semantic"), "project");
    const reopened = await backend("isolation");
    expect((await reopened.list()).length).toBe(2);
    const out = await memoryReadTool.handler({ query: "简短" }, { workspaceRoot: root, memoryBackend: reopened });
    expect(out).toContain("用户要求回答简洁");
    const b = await backend("isolation", "alice", "project-b");
    expect((await b.list()).map((m) => m.name)).toEqual(["表达偏好"]);
    expect((await (await backend("isolation", "bob")).list())).toEqual([]);
    expect(embeddingCalls).toBeGreaterThan(0);
    expect(otherCalls).toBe(0); // infer:false 不触发二次 LLM 提取
  });
  it("同名不同作用域不覆盖,同作用域更新保留 ID 和历史,并发写入收敛", async () => {
    const b = await backend("updates");
    await b.put(fact("约定", "回答简洁"), "user");
    await b.put(fact("约定", "项目约定", "semantic"), "project");
    const first = (await b.list()).find((m) => m.scope === "user")!;
    await Promise.all([b.put(fact("约定", "回答简短"), "user"), b.put(fact("约定", "回答简洁并给证据"), "user")]);
    const all = await b.list();
    expect(all).toHaveLength(2);
    expect(all.find((m) => m.scope === "user")).toMatchObject({ id: first.id, text: "回答简洁并给证据", uses: 2 });
    expect(all.find((m) => m.scope === "project")?.text).toBe("项目约定");
    const history = openSqlite(path.join(root, "updates-history.db"), true);
    try {
      const rows = history.prepare("SELECT action, previous_value, new_value FROM memory_history WHERE memory_id = ? ORDER BY id").all(first.id);
      expect(rows).toHaveLength(3);
      expect(rows[2]).toMatchObject({ action: "UPDATE", previous_value: "回答简短", new_value: "回答简洁并给证据" });
    } finally { history.close(); }
  });
  it("反思纠错/确认走 Mem0,失效记忆不再被召回,删除按 ID 生效", async () => {
    const b = await backend("corrections");
    await b.put(fact("偏好", "用户要求回答简洁"), "user");
    let all = await b.list();
    await applyCorrections([{ target: "偏好", action: "revise", newText: "复杂问题可以详细解释", reason: "用户明确纠正" }], all, () => "不应写文件", "2026-10-26", 3, b);
    all = await b.list();
    expect(all[0]?.text).toBe("复杂问题可以详细解释");
    await applyConfirmed(["偏好"], all, () => "不应写文件", "2026-10-27", b);
    expect((await b.list())[0]?.lastUsed).toBe("2026-10-27");
    await applyCorrections([{ target: "偏好", action: "supersede", reason: "已失效" }], await b.list(), () => "不应写文件", "2026-10-28", 3, b);
    expect(await b.search("简短", 6)).toEqual([]);
    expect(await b.remove(all[0]!.id!)).toEqual(["偏好"]);
  });
  it("锁定和密钥规则覆盖工具及直接后端写入", async () => {
    const b = await backend("protected");
    await b.put({ ...fact("锁定", "回答简洁"), locked: true }, "user");
    await expect(b.put(fact("锁定", "覆盖"), "user")).rejects.toThrow("锁定");
    expect(await b.remove("锁定")).toEqual([]);
    const ctx = { workspaceRoot: root, memoryBackend: b };
    const output = await memoryWriteTool.handler({ text: "不要记录秘密", title: "sk-abcdefghijklmnopqrstuvwxyz1234567890" }, ctx);
    expect(output).toContain("拒绝");
  });
  it("文件导入可重试,保留原文件,删除后重复导入不复活", async () => {
    const dirs = memoryDirs(path.join(root, "workspace"), path.join(root, "home"));
    const files = new FileMemoryBackend(dirs);
    await files.put(fact("迁移", "回答简洁"), "user");
    const b = await backend("migration");
    const ledger = path.join(root, "ledger.json");
    expect(await importFileMemories(b, dirs, ledger)).toEqual({ imported: 1, skipped: 0 });
    expect(await files.list()).toHaveLength(1);
    await b.remove("迁移");
    expect(await importFileMemories(b, dirs, ledger)).toEqual({ imported: 0, skipped: 1 });
    expect(await b.list()).toEqual([]);
    const anotherUser = await backend("migration", "bob");
    expect(await importFileMemories(anotherUser, dirs, ledger)).toEqual({ imported: 1, skipped: 0 });
  });
  it("个人画像保留推断边界,用户陈述不被当作缺失文件淘汰", async () => {
    const memory = { ...fact("推断", "用户可能偏好简洁"), source: "inferred", confidence: 0.4 };
    expect(await validateMemory(memory, root, "2026-10-26")).toEqual({ verdict: "ok" });
    expect(buildMemorySection([{ mem: memory, verdict: "ok" }])).toContain("待验证推断");
    const b = await backend("expiry");
    await b.put({ ...memory, validUntil: "2026-10-20" }, "user");
    const result = await memoryReadTool.handler({ query: "推断" }, { workspaceRoot: root, today: "2026-10-26", memoryBackend: b });
    expect(result).toContain("未找到有效记忆");
  });
  it("禁用记忆不访问配置,配置错误不会偷偷回退文件", async () => {
    expect(await createMemoryBackend({ workspace: root, disabled: true, env: { DAO_MEMORY_BACKEND: "mem0" } })).toBe(disabledMemoryBackend);
    await expect(createMemoryBackend({ workspace: root, home: root, env: { DAO_MEMORY_BACKEND: "mem0" } })).rejects.toThrow("配置不存在");
    expect((await createMemoryBackend({ workspace: root, home: root, env: {} })).kind).toBe("files");
    expect(JSON.parse(expandMemoryEnv('{"key":"${TEST_KEY}"}', { TEST_KEY: 'a"b' })).key).toBe('a"b');
    await expect(memoryWriteTool.handler({ text: "回答简洁" }, { workspaceRoot: root, memoryBackend: disabledMemoryBackend })).resolves.toContain("禁用");
    expect(await memoryProjectId(root)).toHaveLength(24);
  });
});
