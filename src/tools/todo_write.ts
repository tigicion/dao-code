import { z } from "zod";
import { defineTool } from "./types.js";
import { todoStore, type TodoStatus } from "./todo_store.js";
import { msg } from "./lang.js";

const ICON: Record<TodoStatus, string> = {
  pending: "☐",
  in_progress: "▶",
  completed: "☑",
};

// 全部完成且 ≥3 项时提醒一句:自述"完成"不等于验证过,别看着清单全勾就直接收尾报告。
// 参考 CC 的 TodoWrite "全 done 触发 verification nudge" 机制,在这个具体时刻(清单从有
// 未完成变成全部完成)打个岔。
//
// 2026-07-27 真实复测(adaptive-rejection-sampler)撞见这条提醒本身没能防住的具体绕过:
// 模型调用 VerifyDone 拿到"逐条对照任务原文"的提示后,下一步却是再调一次 TodoWrite 勾掉
// 自己先前写的、宽泛的进度条目("Writing ars.R"/"Running tests"这类,不是任务原文的具体
// 句子),然后直接收尾——把"勾清单"当成了"核对过原文"的替代品。原文案只说"调用 VerifyDone
// 核实",没有点破"核实的对象是任务原文本身,不是这份清单";补上这句降低被同一个绕过路径
// 再次绕过的概率(不能杜绝——VerifyDone 描述本身已经把这条路径列进红旗表,这里是第二道
// 防线,同一个提醒在决策点上再出现一次)。
function completionNudge(todos: { status: TodoStatus }[]): string {
  if (todos.length < 3 || !todos.every((t) => t.status === "completed")) return "";
  return msg(
    "\n\n(清单已全部勾完——这不是完成的信号,只是你自己的进度记录。收尾前必须调用 VerifyDone," +
      "且核对的对象是【任务原文本身】,不是这份清单——清单条目是你自己写的,勾完不代表已经对照过" +
      "原文的具体条款。非琐碎改动额外派 verify 子代理独立验证。)",
    "\n\n(All items checked off — this is not a completion signal, only your own progress record. You must call VerifyDone before wrapping up, and check " +
      "against the ORIGINAL TASK TEXT itself, not this checklist — these items are your own wording; checking them off doesn't mean you cross-checked the " +
      "task's actual clauses. For non-trivial changes also dispatch a verify subagent.)",
  );
}

export const todoWriteTool = defineTool({
  name: "TodoWrite",
  description:
    "维护单层任务清单——【每次调用传完整列表】,不是增量补丁,少传的项就等于删掉了。状态 pending/in_progress/completed;" +
    "同一时刻最多一个 in_progress(可以是 0 个,不强制必须有一个在跑),多于一个会报错。用于拆解多步任务、边做边更新。" +
    "3 步以上的任务主动用它,别憋到最后一次性罗列;每完成一步就立刻把它标 completed、下一步标 in_progress 再传完整列表," +
    "不要攒到最后一起改。传空数组 = 清空整个清单。这是给你自己和用户看的轻量进度清单,不是任务对象系统——" +
    "要追踪真正在后台跑的子任务(有 id、能查状态和结果)用 TaskCreate/TaskList 那一套。同一时刻两个都" +
    "标 in_progress 会直接报错、整表都不会生效,发现报错就检查是不是漏改了上一步的状态。\n" +
    "拆分粒度要具体到能用一次工具调用验证完成与否(比如'实现X函数并用样例数据跑一次',而不是笼统的" +
    "'设计并实现X');撞见推翻原计划的新信息(报错崩溃、格式对不上、发现隐藏复杂度)时,更新清单内容反映" +
    "新认知——不是只勾掉旧条目状态,原样重发同一份内容等于没更新。\n" +
    "每个任务可选 activeForm(进行式描述,如 'Running tests'),有则 UI 显示进行式而非祈使式;省略时用 content。",
  descriptionEn:
    "Maintains a flat task checklist — [pass the complete list every call], not an incremental patch; anything you leave out is effectively deleted. " +
    "Status: pending/in_progress/completed; at most one in_progress at a time (zero is fine too, not required to always have one running), more than one errors. " +
    "Use to decompose multi-step tasks and update as you go. Use proactively for tasks with 3+ steps rather than listing everything at the end; as soon as a step " +
    "completes, mark it completed and the next one in_progress, then pass the full updated list — don't batch changes until the end. Passing an empty array clears " +
    "the whole list. This is a lightweight progress checklist for you and the user to see, not a task-object system — for tracking actual background subtasks " +
    "(with an id, queryable status/result), use the TaskCreate/TaskList family instead. Having two items in_progress at once errors outright and the whole list " +
    "is rejected — if you hit that error, check whether you forgot to update the previous step's status.\n" +
    "Break steps down to a granularity you can verify with a single tool call (e.g. 'implement X and run it against sample input', not a broad 'design and " +
    "implement X'); when you hit information that invalidates the plan (a crash, a spec mismatch, hidden complexity), update the list content to reflect what " +
    "you now know — just checking off the old wording without changing it isn't an update.\n" +
    "Each task optionally takes activeForm (present continuous, e.g. 'Running tests'); if provided, UI shows it instead of content; falls back to content when omitted.",
  capability: "plan",
  approval: "auto",
  schema: z.object({
    todos: z
      .array(
        z.object({
          content: z.string().describe("祈使式描述,如 'Run tests'"),
          status: z.enum(["pending", "in_progress", "completed"]),
          activeForm: z.string().optional().describe("进行式描述(参考),如 'Running tests';省略时用 content"),
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
    return args.todos.map((t) => `${ICON[t.status]} ${t.activeForm ?? t.content}`).join("\n") + completionNudge(args.todos);
  },
});
