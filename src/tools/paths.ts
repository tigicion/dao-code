import path from "node:path";
import { realpathSync } from "node:fs";
import { hasSuspiciousUnicode } from "../permissions/sanitize.js";

const within = (root: string, abs: string): boolean => {
  const rel = path.relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

// 经符号链接解析后,abs 是否逃逸出 root(区内软链接指向区外)。root 不在磁盘上时无从判断,返回 false。
function realEscapes(root: string, abs: string): boolean {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return false;
  }
  let probe = abs;
  for (;;) {
    try {
      const real = realpathSync(probe); // 解析最近的已存在祖先
      const realAbs = probe === abs ? real : path.join(real, path.relative(probe, abs));
      return !within(realRoot, realAbs);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return false; // 到根仍无已存在祖先 → 纯路径判断已足够
      probe = parent;
    }
  }
}

// 解析相对工作区根的绝对路径,并标注是否在工作区之外(含符号链接逃逸)。不抛错。
// 供"可申请权限访问区外"的读类工具用:external=true 时由调用方走审批,而非直接拒绝。
export function classifyPath(workspaceRoot: string, p: string): { abs: string; external: boolean } {
  const root = path.resolve(workspaceRoot);
  // S1.2:含 null 字节/零宽/同形伪装的路径一律按"区外"处理 → 走审批,不静默放行。
  if (hasSuspiciousUnicode(p)) return { abs: path.resolve(root, p.replace(/\0/g, "")), external: true };
  const abs = path.resolve(root, p);
  return { abs, external: !within(root, abs) || realEscapes(root, abs) };
}

// 把 p 解析为工作区内的绝对路径;落在区外(或经软链接逃逸)直接拒绝。写类工具仍用它(区外写有风险)。
export function resolveInWorkspace(workspaceRoot: string, p: string): string {
  const { abs, external } = classifyPath(workspaceRoot, p);
  if (external) throw new Error(`路径越界:${p} 超出工作区`);
  return abs;
}

// 写路径解析:解析成绝对路径即可(任意路径,含工作区外)。是否放行【完全交给权限系统】——
// 写工具 capability=write、approval=required,会经 gate 审批(规则/ask)+ 敏感路径 1g 检查;
// 不再在工具内单设硬边界(否则 headless 区外写会直接失败、且与 gate 重复)。
export function resolveWritePath(workspaceRoot: string, p: string): string {
  return classifyPath(workspaceRoot, p).abs;
}
