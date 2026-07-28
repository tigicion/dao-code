import { describe, it, expect, beforeEach } from "vitest";
import { todoWriteTool } from "./todo_write.js";
import { todoStore } from "./todo_store.js";

beforeEach(() => todoStore.reset());
const ctx = { workspaceRoot: "/tmp" };

describe("TodoWrite tool", () => {
  it("renders todos with status icons and stores them", async () => {
    const out = await todoWriteTool.handler(
      {
        todos: [
          { content: "design", status: "completed" },
          { content: "build", status: "in_progress" },
          { content: "test", status: "pending" },
        ],
      },
      ctx,
    );
    expect(out).toContain("☑ design");
    expect(out).toContain("▶ build");
    expect(out).toContain("☐ test");
    expect(todoStore.get()).toHaveLength(3);
  });

  it("rejects more than one in_progress", async () => {
    await expect(
      todoWriteTool.handler(
        {
          todos: [
            { content: "a", status: "in_progress" },
            { content: "b", status: "in_progress" },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow(/in_progress/);
  });

  it("clears the list when given an empty array", async () => {
    const out = await todoWriteTool.handler({ todos: [] }, ctx);
    expect(out).toBe("(任务清单已清空)");
    expect(todoStore.get()).toHaveLength(0);
  });

  it("declares plan capability and auto approval", () => {
    expect(todoWriteTool.capability).toBe("plan");
    expect(todoWriteTool.approval).toBe("auto");
    expect(todoWriteTool.name).toBe("TodoWrite");
  });

  it("all ≥3 items completed → appends a verification nudge", async () => {
    const out = await todoWriteTool.handler(
      {
        todos: [
          { content: "a", status: "completed" },
          { content: "b", status: "completed" },
          { content: "c", status: "completed" },
        ],
      },
      ctx,
    );
    expect(out).toContain("verify 子代理");
  });

  it("清单全勾完提醒:强制核对对象是任务原文本身,不是清单本身(2026-07-27 adaptive-rejection-sampler 撞见的具体绕过)", async () => {
    // 真实复测撞见:模型调用 VerifyDone 拿到提示后,下一步是再调 TodoWrite 勾自己写的进度
    // 清单、然后直接收尾——用勾清单代替了回去核对原文。补上"核对对象是任务原文,不是这份
    // 清单"这句,防止同一个绕过路径在这个决策点上被同样忽略。
    const out = await todoWriteTool.handler(
      { todos: [{ content: "a", status: "completed" }, { content: "b", status: "completed" }, { content: "c", status: "completed" }] },
      ctx,
    );
    expect(out).toContain("VerifyDone");
    expect(out).toContain("任务原文本身");
    expect(out).toContain("这不是完成的信号"); // 明确否定"清单勾完=完成"这个错误推论
  });

  it("fewer than 3 items, all completed → no nudge", async () => {
    const out = await todoWriteTool.handler(
      {
        todos: [
          { content: "a", status: "completed" },
          { content: "b", status: "completed" },
        ],
      },
      ctx,
    );
    expect(out).not.toContain("verify 子代理");
  });

  it("≥3 items but not all completed → no nudge", async () => {
    const out = await todoWriteTool.handler(
      {
        todos: [
          { content: "a", status: "completed" },
          { content: "b", status: "completed" },
          { content: "c", status: "pending" },
        ],
      },
      ctx,
    );
    expect(out).not.toContain("verify 子代理");
  });

  it("activeForm overrides content in output when provided", async () => {
    const out = await todoWriteTool.handler(
      {
        todos: [
          { content: "Run tests", status: "in_progress", activeForm: "Running tests" },
          { content: "Build project", status: "pending", activeForm: "Building project" },
        ],
      },
      ctx,
    );
    expect(out).toContain("▶ Running tests");
    expect(out).not.toContain("▶ Run tests");
    expect(out).toContain("☐ Building project");
    expect(out).not.toContain("☐ Build project");
    const stored = todoStore.get();
    expect(stored[0]?.activeForm).toBe("Running tests");
    expect(stored[0]?.content).toBe("Run tests");
  });

  it("activeForm omitted -> falls back to content", async () => {
    const out = await todoWriteTool.handler(
      {
        todos: [{ content: "Write code", status: "in_progress" }],
      },
      ctx,
    );
    expect(out).toContain("▶ Write code");
  });
});
