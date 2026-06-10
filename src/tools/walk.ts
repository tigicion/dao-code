import { promises as fs } from "node:fs";
import path from "node:path";

const IGNORE = new Set(["node_modules", ".git", "dist", ".dao", ".codeds"]);

// 递归列出 root 下的所有文件(跳过常见忽略目录),返回绝对路径与相对 root 的路径。
export async function* walkFiles(
  root: string,
): AsyncGenerator<{ abs: string; rel: string }> {
  async function* rec(dir: string): AsyncGenerator<{ abs: string; rel: string }> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE.has(e.name)) continue;
        yield* rec(abs);
      } else if (e.isFile()) {
        yield { abs, rel: path.relative(root, abs) };
      }
    }
  }
  yield* rec(root);
}
