// App 渲染用的纯函数(可单测),与 Ink 组件解耦。

// 截断:超过 max 只留前 max 项,返回隐藏数(verbose 传 Infinity 全显)。泛型,行/diff 行通用。
export function clampLines<T>(lines: T[], max: number): { shown: T[]; hidden: number } {
  if (lines.length <= max) return { shown: lines, hidden: 0 };
  return { shown: lines.slice(0, max), hidden: lines.length - max };
}

export type TodoStatus = "pending" | "in_progress" | "completed";
export interface TodoItem {
  status: TodoStatus;
  content: string;
}

const ICON_STATUS: Record<string, TodoStatus> = { "☐": "pending", "▶": "in_progress", "☑": "completed" };

// 解析 todo_write 的结果文本(每行 "图标 内容")成清单项,供复选框渲染。
export function parseTodoResult(content: string): TodoItem[] {
  const out: TodoItem[] = [];
  for (const line of content.split("\n")) {
    const m = /^([☐▶☑])\s+(.*)$/.exec(line.trim());
    if (m) out.push({ status: ICON_STATUS[m[1]!]!, content: m[2]! });
  }
  return out;
}
