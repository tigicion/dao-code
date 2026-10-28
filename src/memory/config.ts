import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { disabledMemoryBackend, FileMemoryBackend, memoryDirs, memoryProjectId, type MemoryBackend } from "./backend.js";
import { createMem0Client, Mem0MemoryBackend } from "./mem0.js";

const component = z.object({ provider: z.literal("openai"), config: z.record(z.unknown()) });
const schema = z.object({
  userId: z.string().trim().min(1).default("local"),
  embedder: component,
  llm: component.optional(),
  dimension: z.number().int().positive(),
});

export function expandMemoryEnv(raw: string, env: NodeJS.ProcessEnv): string {
  // 在解析后的字符串值上替换,避免凭据中的引号破坏 JSON。
  const value = JSON.parse(raw);
  const visit = (v: unknown): unknown => {
    if (typeof v === "string") return v.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, key: string) => {
      if (!env[key]) throw new Error(`Mem0 配置缺少环境变量 ${key}`);
      return env[key]!;
    });
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, visit(val)]));
    return v;
  };
  return JSON.stringify(visit(value));
}

export async function createMemoryBackend(options: {
  workspace: string; home?: string; disabled?: boolean; env?: NodeJS.ProcessEnv;
  llm?: { baseUrl: string; apiKey: string; model: string };
}): Promise<MemoryBackend> {
  if (options.disabled) return disabledMemoryBackend;
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const selection = env.DAO_MEMORY_BACKEND;
  if (selection && selection !== "mem0" && selection !== "files") throw new Error("DAO_MEMORY_BACKEND 仅支持 mem0 或 files。");
  if (selection === "files") return new FileMemoryBackend(memoryDirs(options.workspace, home));
  const configPath = env.DAO_MEM0_CONFIG ?? path.join(home, ".dao", "mem0.json");
  let raw: string;
  try { raw = await fs.readFile(configPath, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("无法读取 Mem0 配置文件。");
    if (selection === "mem0" || env.DAO_MEM0_CONFIG) throw new Error("Mem0 配置不存在,请先创建 ~/.dao/mem0.json 或设置 DAO_MEM0_CONFIG。");
    return new FileMemoryBackend(memoryDirs(options.workspace, home));
  }
  let config: z.infer<typeof schema>;
  try { config = schema.parse(JSON.parse(expandMemoryEnv(raw, env))); }
  catch { throw new Error("Mem0 配置无效:需要 embedder、dimension 及有效环境变量;可选 userId、llm。请检查配置,勿输出凭据。"); }
  const llm = config.llm ?? (options.llm ? { provider: "openai", config: { baseURL: options.llm.baseUrl, apiKey: options.llm.apiKey, model: options.llm.model } } : undefined);
  if (!llm) throw new Error("Mem0 需要 llm 配置或 Dao 当前模型配置。");
  // 本地向量和历史使用明确的持久路径,不依赖 SDK 的工作目录默认值。
  const dir = path.join(home, ".dao", "mem0");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const fingerprintPath = path.join(dir, "embedding.json");
  const fingerprint = JSON.stringify({ provider: config.embedder.provider, model: config.embedder.config.model,
    baseURL: config.embedder.config.baseURL, dimension: config.dimension });
  try {
    const previous = await fs.readFile(fingerprintPath, "utf8");
    if (previous !== fingerprint) throw new Error("Embedding 模型、地址或维度已改变。请备份并重建 Mem0 向量库,不能混用不同向量空间。");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.writeFile(fingerprintPath, fingerprint, { flag: "wx", mode: 0o600 });
  }
  const client = await createMem0Client({
    embedder: config.embedder, llm,
    vectorStore: { provider: "memory", config: { dbPath: path.join(dir, "vectors.db"), dimension: config.dimension } },
    historyStore: { provider: "sqlite", config: { historyDbPath: path.join(dir, "history.db") } },
  });
  return new Mem0MemoryBackend(client, config.userId, await memoryProjectId(options.workspace));
}
