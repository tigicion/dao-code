import { createHash } from "node:crypto";
import type { Memory as Mem0, MemoryConfig, MemoryItem } from "mem0ai/oss";
import type { Memory } from "./types.js";
import { assertSafeMemory, type MemoryBackend, type MemoryEntry } from "./backend.js";
import { dedupKey, slug, type Scope } from "./store.js";

export type Mem0Client = Pick<Mem0, "add" | "getAll" | "search" | "update" | "delete">;
const scopes: Scope[] = ["user", "project", "knowledge"];

// Dao 继续负责提取、置信度和纠错;Mem0 负责向量召回、持久化和变更历史。
// 已提炼的事实用 infer:false 写入,避免二次提取损失理由、适用条件和来源。
export class Mem0MemoryBackend implements MemoryBackend {
  readonly kind = "mem0" as const;
  readonly migrationIdentity: string;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private client: Mem0Client, private userId: string, private projectId: string) {
    this.migrationIdentity = createHash("sha256").update(userId).digest("hex").slice(0, 24);
  }
  private filters(scope: Scope) {
    return { user_id: this.userId, agent_id: scope === "project" ? `dao:project:${this.projectId}` : `dao:${scope}` };
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.pending.then(fn, fn);
    this.pending = result.catch(() => {});
    return result;
  }
  private decode(item: MemoryItem, scope: Scope): MemoryEntry {
    const m = item.metadata?.dao as Memory | undefined;
    if (!m || typeof m.name !== "string" || !["active", "superseded"].includes(m.status)) {
      throw new Error("Mem0 中存在无法识别的 Dao 记忆元数据,请检查配置的用户身份和数据库。");
    }
    return { ...m, text: item.memory, id: item.id, scope };
  }
  private async listScope(scope: Scope): Promise<MemoryEntry[]> {
    // SDK 的 getAll 默认只有 20 条;逐步扩容,不把截断结果伪装成全量。
    for (let topK = 256; topK <= 131072; topK *= 2) {
      const result = await this.client.getAll({ filters: this.filters(scope), topK, showExpired: true });
      if (result.results.length < topK) return result.results.map((m) => this.decode(m, scope));
    }
    throw new Error("记忆数量超过当前全量索引上限,请缩小记忆库后重试。");
  }
  async list(): Promise<MemoryEntry[]> {
    return (await Promise.all(scopes.map((s) => this.listScope(s)))).flat().filter((m) => m.status === "active");
  }
  async search(query: string, limit: number): Promise<MemoryEntry[]> {
    const all = await this.list();
    const exact = all.filter((m) => m.id === query || m.name === query || m.title === query);
    if (exact.length) return exact.slice(0, limit);
    const hits = (await Promise.all(scopes.map(async (scope) => {
      const result = await this.client.search(query, { filters: { ...this.filters(scope), dao_status: "active" }, topK: limit });
      return result.results.map((item) => ({ memory: this.decode(item, scope), score: item.score ?? 0 }));
    }))).flat();
    return hits.filter((h) => h.memory.status === "active").sort((a, b) => b.score - a.score).slice(0, limit).map((h) => h.memory);
  }
  put(memory: Memory, scope: Scope): Promise<{ action: "added" | "updated"; name: string }> {
    assertSafeMemory(memory);
    return this.serial(async () => {
      const existing = await this.listScope(scope);
      const match = existing.find((m) => m.status === "active" && (m.name === memory.name || dedupKey(m) === dedupKey(memory)));
      if (match?.locked) throw new Error("该记忆已锁定,不能覆盖。");
      if (match) {
        const updated = { ...memory, name: match.name, created: match.created, uses: match.uses + 1, locked: match.locked };
        await this.client.update(match.id!, { text: updated.text, metadata: { dao: updated, dao_status: updated.status } });
        return { action: "updated", name: match.name };
      }
      const filters = this.filters(scope);
      const result = await this.client.add(memory.text, { userId: filters.user_id, agentId: filters.agent_id, infer: false, metadata: { dao: memory, dao_status: memory.status } });
      if (result.results.length !== 1) throw new Error("Mem0 未确认写入一条完整记忆。");
      return { action: "added", name: memory.name };
    });
  }
  replace(memory: MemoryEntry): Promise<void> {
    assertSafeMemory(memory);
    return this.serial(async () => {
      const current = (await this.listScope(memory.scope)).find((m) => m.id === memory.id);
      if (!current || current.locked) throw new Error("记忆不存在或已锁定。");
      const { id: _id, scope: _scope, ...data } = memory;
      await this.client.update(current.id!, { text: data.text, metadata: { dao: data, dao_status: data.status } });
    });
  }
  remove(key: string): Promise<string[]> {
    return this.serial(async () => {
      const all = (await Promise.all(scopes.map((s) => this.listScope(s)))).flat();
      const matches = all.filter((m) => !m.locked && (m.id === key || m.name === key || dedupKey(m) === slug(key)));
      for (const match of matches) await this.client.delete(match.id!);
      return matches.map((m) => m.name);
    });
  }
}

export async function createMem0Client(config: Partial<MemoryConfig>): Promise<Mem0Client> {
  // 必须早于动态 import:SDK 在模块初始化时读取遥测开关。
  process.env.MEM0_TELEMETRY ??= "false";
  const { Memory } = await import("mem0ai/oss");
  return new Memory(config);
}
