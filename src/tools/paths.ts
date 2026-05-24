import path from "node:path";
import { realpathSync } from "node:fs";

const within = (root: string, abs: string): boolean => {
  const rel = path.relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

// 把 p 相对 workspaceRoot 解析为绝对路径;拒绝任何落在 workspace 之外的结果。
// 额外解符号链接:防止区内的软链接指向区外实现逃逸(对已存在路径或其最近的已存在祖先做 realpath 校验)。
export function resolveInWorkspace(workspaceRoot: string, p: string): string {
  const root = path.resolve(workspaceRoot);
  const abs = path.resolve(root, p);
  if (!within(root, abs)) throw new Error(`路径越界:${p} 超出工作区`);

  // 符号链接逃逸校验:仅当工作区根真实存在时进行(否则无真实链接可逃逸)。
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return abs; // 根不在磁盘上(如测试用虚拟路径)→ 纯路径校验已足够
  }
  // 解析真实路径再校验。新建文件本身不存在 → 校验其最近的已存在祖先目录。
  let probe = abs;
  for (;;) {
    try {
      const real = realpathSync(probe);
      const realAbs = probe === abs ? real : path.join(real, path.relative(probe, abs));
      if (!within(realRoot, realAbs)) throw new Error(`路径越界:${p} 经符号链接逃逸出工作区`);
      return abs;
    } catch (e) {
      if (e instanceof Error && e.message.includes("逃逸")) throw e;
      const parent = path.dirname(probe);
      if (parent === probe) return abs; // 到根仍无已存在祖先,path 层已校验过
      probe = parent;
    }
  }
}
