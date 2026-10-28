// 可由 Node 源码运行,也可经 scripts/bundle.ts --entry 编译后在仓库外运行。
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createMemoryBackend } from "../src/memory/config.js";
import { memoryWriteTool } from "../src/tools/memory_write.js";
import { memoryReadTool } from "../src/tools/memory_read.js";

const root = await mkdtemp(path.join(os.tmpdir(), "dao-mem0-smoke-"));
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  assert.equal(req.url, "/embeddings");
  const input = JSON.parse(raw).input;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ data: (Array.isArray(input) ? input : [input]).map((_, index) => ({ index, embedding: [1, 0, 0] })) }));
});
try {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await mkdir(path.join(root, ".dao"));
  await writeFile(path.join(root, ".dao", "mem0.json"), JSON.stringify({
    userId: "smoke", dimension: 3,
    embedder: { provider: "openai", config: { apiKey: "test", model: "test", baseURL } },
    llm: { provider: "openai", config: { apiKey: "test", model: "unused", baseURL } },
  }));
  const options = { workspace: root, home: root, env: { DAO_MEMORY_BACKEND: "mem0" } };
  const backend = await createMemoryBackend(options);
  const ctx = { workspaceRoot: root, homeDir: root, memoryBackend: backend };
  assert.match(await memoryWriteTool.handler({ title: "沟通偏好", text: "用户偏好简洁的回答", type: "user" }, ctx), /已记住/);
  const reopened = await createMemoryBackend(options);
  assert.equal((await reopened.list()).length, 1);
  assert.match(await memoryReadTool.handler({ query: "怎样表达比较合适" }, { ...ctx, memoryBackend: reopened }), /用户偏好简洁/);
  assert.equal((await reopened.remove("沟通偏好")).length, 1);
  assert.equal((await reopened.list()).length, 0);
  console.log("Mem0 OSS 冒烟通过:配置、写入、重开、语义召回、删除。");
} finally {
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
