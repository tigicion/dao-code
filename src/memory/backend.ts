import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import type { Memory } from "./types.js";
import { deleteMemory, loadAllMemories, upsertMemory, writeMemory, type Scope } from "./store.js";
import { findSecrets } from "../permissions/secrets.js";

export interface MemoryEntry extends Memory { scope: Scope; id?: string; }
export interface MemoryBackend {
  readonly kind: "files" | "mem0" | "disabled";
  readonly migrationIdentity?: string;
  list(): Promise<MemoryEntry[]>;
  search(query: string, limit: number): Promise<MemoryEntry[]>;
  put(memory: Memory, scope: Scope): Promise<{ action: "added" | "updated"; name: string }>;
  replace(memory: MemoryEntry): Promise<void>;
  remove(key: string): Promise<string[]>;
}

export function assertSafeMemory(memory: Memory): void {
  if (findSecrets(JSON.stringify(memory)).length) throw new Error("拒绝写入记忆:内容或元数据疑似含密钥。");
}

export function memoryDirs(workspace: string, home: string): Record<Scope, string> {
  return { project: path.join(workspace, ".dao", "memory"), user: path.join(home, ".dao", "memory"), knowledge: path.join(home, ".dao", "knowledge") };
}

// 真实绝对路径避免同名仓库相互串库;显式共享用户身份仍由配置控制。
export async function memoryProjectId(workspace: string): Promise<string> {
  const root = await fs.realpath(workspace);
  return createHash("sha256").update(root).digest("hex").slice(0, 24);
}

export class FileMemoryBackend implements MemoryBackend {
  readonly kind = "files" as const;
  constructor(readonly dirs: Record<Scope, string>) {}
  async list(): Promise<MemoryEntry[]> {
    return (await Promise.all((Object.keys(this.dirs) as Scope[]).map(async (scope) =>
      (await loadAllMemories(this.dirs[scope])).map((m) => ({ ...m, scope })),
    ))).flat();
  }
  async search(query: string, limit: number): Promise<MemoryEntry[]> {
    const all = await this.list();
    const exact = all.filter((m) => m.name === query || m.title === query);
    if (exact.length) return exact.slice(0, limit);
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter((m) => terms.every((t) => `${m.name} ${m.title ?? ""} ${m.text}`.toLowerCase().includes(t))).slice(0, limit);
  }
  async put(memory: Memory, scope: Scope) {
    assertSafeMemory(memory);
    const existing = await loadAllMemories(this.dirs[scope]);
    if (existing.some((m) => m.locked && (m.name === memory.name || m.title === memory.title && !!m.title))) throw new Error("该记忆已锁定,不能覆盖。");
    return upsertMemory(this.dirs[scope], memory, existing);
  }
  async replace(memory: MemoryEntry): Promise<void> {
    assertSafeMemory(memory);
    await writeMemory(this.dirs[memory.scope], memory);
  }
  remove(key: string): Promise<string[]> { return deleteMemory(Object.values(this.dirs), key); }
}

export const disabledMemoryBackend: MemoryBackend = {
  kind: "disabled", list: async () => [], search: async () => [],
  put: async () => { throw new Error("本会话已禁用记忆。"); },
  replace: async () => { throw new Error("本会话已禁用记忆。"); },
  remove: async () => { throw new Error("本会话已禁用记忆。"); },
};
