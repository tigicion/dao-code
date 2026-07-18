export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  content: string;
  status: TodoStatus;
  activeForm?: string; // 进行式描述(参考 TodoWrite activeForm),如 "Running tests"
}

class TodoStore {
  private todos: Todo[] = [];
  set(todos: Todo[]): void {
    this.todos = todos;
  }
  get(): Todo[] {
    return this.todos;
  }
  reset(): void {
    this.todos = [];
  }
}

export const todoStore = new TodoStore();

const ICON: Record<TodoStatus, string> = { pending: "☐", in_progress: "▶", completed: "☑" };

// 把任务清单格式化成可读文本(用于压缩后重注入,使计划穿越压缩、防长任务漂移)。
// 有 activeForm 时优先显示进行式(参考)。
export function formatTodos(todos: Todo[]): string {
  return todos.map((t) => `${ICON[t.status]} ${t.activeForm ?? t.content}`).join("\n");
}
