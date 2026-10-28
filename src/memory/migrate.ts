import path from "node:path";
import { promises as fs } from "node:fs";
import { FileMemoryBackend, type MemoryBackend } from "./backend.js";
import { dedupKey, migrateLegacy, type Scope } from "./store.js";

// 用户显式执行 /memory import 后才迁移。保留源文件;每条成功后记账,重试不复活已删除记忆。
export async function importFileMemories(backend: MemoryBackend, dirs: Record<Scope, string>, ledgerPath: string): Promise<{ imported: number; skipped: number }> {
  if (backend.kind !== "mem0") throw new Error("仅 Mem0 模式支持导入旧记忆。");
  let ledger: string[] = [];
  try { ledger = JSON.parse(await fs.readFile(ledgerPath, "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("迁移记录损坏,已停止导入。"); }
  if (!Array.isArray(ledger) || ledger.some((v) => typeof v !== "string")) throw new Error("迁移记录格式无效。");
  const done = new Set(ledger);
  const today = new Date().toISOString().slice(0, 10);
  for (const dir of Object.values(dirs)) await migrateLegacy(dir, today);
  const files = await new FileMemoryBackend(dirs).list();
  let imported = 0, skipped = 0;
  for (const memory of files) {
    const key = `${backend.migrationIdentity ?? "default"}:${dirs[memory.scope]}/${memory.name}`;
    if (done.has(key)) { skipped++; continue; }
    // 不覆盖用户已经在 Mem0 中更新的同名条目。
    const existing = await backend.list();
    if (existing.some((m) => m.scope === memory.scope && (m.name === memory.name || dedupKey(m) === dedupKey(memory)))) skipped++;
    else { await backend.put(memory, memory.scope); imported++; }
    done.add(key);
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
    const temp = `${ledgerPath}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify([...done], null, 2), { mode: 0o600 });
    await fs.rename(temp, ledgerPath);
  }
  return { imported, skipped };
}
