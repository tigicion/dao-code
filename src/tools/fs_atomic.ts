import { promises as fs } from "node:fs";
import path from "node:path";

// 原子写:先写同目录临时文件,再 rename 替换。中途崩溃/被 kill 不会留下半截损坏的源文件
// (rename 在同一文件系统上是原子操作)。长任务里保护用户源码不被写到一半。
export async function atomicWrite(abs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.dao-${process.pid}-${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, abs);
  } catch (e) {
    try { await fs.unlink(tmp); } catch {}
    throw e;
  }
}
