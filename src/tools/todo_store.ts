export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  content: string;
  status: TodoStatus;
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
