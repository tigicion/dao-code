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

  // 解析真实路径(软链接)再校验。新建文件本身不存在 → 校验其最近的已存在祖先目录。
  const realRoot = (() => { try { return realpathSync(root); } catch { return root; } })();
  let probe = abs;
  for (;;) {
    try {
      const real = realpathSync(probe);
      const realAbs = probe === abs ? real : path.join(real, path.relative(probe, abs));
      if (!within(realRoot, realAbs)) throw new Error(`路径越界:${p} 经符号链接逃逸出工作区`);
      break;
    } catch (e) {
      if (e instanceof Error && e.message.includes("逃逸")) throw e;
      const parent = path.dirname(probe);
      if (parent === probe) break; // 到根了,放行(path 层已校验过 abs 在区内)
      probe = parent;
    }
  }
  return abs;
}
