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
    "维护单层任务清单——【每次调用传完整列表】,不是增量补丁,少传的项就等于删掉了。状态 pending/in_progress/completed;" +
    "同一时刻最多一个 in_progress(可以是 0 个,不强制必须有一个在跑),多于一个会报错。用于拆解多步任务、边做边更新。" +
    "3 步以上的任务主动用它,别憋到最后一次性罗列;每完成一步就立刻把它标 completed、下一步标 in_progress 再传完整列表," +
    "不要攒到最后一起改。传空数组 = 清空整个清单。这是给你自己和用户看的轻量进度清单,不是任务对象系统——" +
    "要追踪真正在后台跑的子任务(有 id、能查状态和结果)用 task_create/task_list 那一套。同一时刻两个都" +
    "标 in_progress 会直接报错、整表都不会生效,发现报错就检查是不是漏改了上一步的状态。",
  descriptionEn:
    "Maintains a flat task checklist — [pass the complete list every call], not an incremental patch; anything you leave out is effectively deleted. " +
    "Status: pending/in_progress/completed; at most one in_progress at a time (zero is fine too, not required to always have one running), more than one errors. " +
    "Use to decompose multi-step tasks and update as you go. Use proactively for tasks with 3+ steps rather than listing everything at the end; as soon as a step " +
    "completes, mark it completed and the next one in_progress, then pass the full updated list — don't batch changes until the end. Passing an empty array clears " +
    "the whole list. This is a lightweight progress checklist for you and the user to see, not a task-object system — for tracking actual background subtasks " +
    "(with an id, queryable status/result), use the task_create/task_list family instead. Having two items in_progress at once errors outright and the whole list " +
    "is rejected — if you hit that error, check whether you forgot to update the previous step's status.",
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
