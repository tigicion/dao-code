import { z } from "zod";
import { defineTool } from "./types.js";
import { todoStore, type TodoStatus } from "./todo_store.js";

const ICON: Record<TodoStatus, string> = {
  pending: "☐",
  in_progress: "▶",
  completed: "☑",
};

export const todoWriteTool = defineTool({
  name: "todo_write",
  description:
    "维护单层任务清单(每次整表替换)。状态 pending/in_progress/completed;同一时刻最多一个 in_progress。用于拆解多步任务、边做边更新。",
  descriptionEn:
    "Maintains a flat task checklist (full replacement each time). Status: pending/in_progress/completed; at most one in_progress at a time. Use to decompose multi-step tasks and update as you go.",
  capability: "plan",
  approval: "auto",
  schema: z.object({
    todos: z
      .array(
        z.object({
          content: z.string(),
          status: z.enum(["pending", "in_progress", "completed"]),
        }),
      )
      .describe("完整任务列表"),
  }),
  handler: async (args) => {
    const inProgress = args.todos.filter((t) => t.status === "in_progress").length;
    if (inProgress > 1) {
      throw new Error(`同一时刻最多一个 in_progress,当前有 ${inProgress} 个`);
    }
    todoStore.set(args.todos);
    if (args.todos.length === 0) return "(任务清单已清空)";
    return args.todos.map((t) => `${ICON[t.status]} ${t.content}`).join("\n");
  },
});
