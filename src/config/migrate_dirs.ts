import { promises as fs } from "node:fs";

export type MigrateResult = "migrated" | "skipped" | "absent";

// codeds → DAO CODE 改名的一次性数据迁移:启动时把旧 .codeds/ 整体改名为 .dao/。
// 新目录已存在说明已迁移过(或用户手动建了),不动旧目录,避免覆盖。
export async function migrateLegacyDir(oldDir: string, newDir: string): Promise<MigrateResult> {
  const oldStat = await fs.stat(oldDir).catch(() => undefined);
  if (!oldStat?.isDirectory()) return "absent";
  const newStat = await fs.stat(newDir).catch(() => undefined);
  if (newStat) return "skipped";
  await fs.rename(oldDir, newDir);
  return "migrated";
}
