import path from "node:path";

// 把 p 相对 workspaceRoot 解析为绝对路径;拒绝任何落在 workspace 之外的结果。
export function resolveInWorkspace(workspaceRoot: string, p: string): string {
  const root = path.resolve(workspaceRoot);
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel === "") return abs; // 根目录本身
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`路径越界:${p} 超出工作区`);
  }
  return abs;
}
