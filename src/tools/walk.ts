import { promises as fs } from "node:fs";
import path from "node:path";

const IGNORE = new Set(["node_modules", ".git", "dist", ".dao", ".codeds"]);

// 递归列出 root 下的所有文件(跳过常见忽略目录),返回绝对路径与相对 root 的路径。
// root 本身指向一个文件(不是目录)时,当作"只搜这一个文件"处理,而不是像 fs.readdir
// 对文件路径报 ENOTDIR 那样被 catch 吞掉、静默返回空——那样会让 Grep/Glob 的 path 参数
// 指到具体文件时看起来像"搜过了、真的没有"，跟"pattern/glob 本身没命中"没法区分
// (真实撞见过:sanitize-git-repo 里模型把 path 精确指到某个可疑文件本身,结果被这个
// bug 误判成"确认干净",实际上那个文件里真的有匹配)。
export async function* walkFiles(
  root: string,
): AsyncGenerator<{ abs: string; rel: string }> {
  try {
    const st = await fs.stat(root);
    if (st.isFile()) {
      yield { abs: root, rel: path.basename(root) };
      return;
    }
  } catch {
    return;
  }
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
