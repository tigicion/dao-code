import { describe, it, expect, beforeEach } from "vitest";
import { todoWriteTool } from "./todo_write.js";
import { todoStore } from "./todo_store.js";

beforeEach(() => todoStore.reset());
const ctx = { workspaceRoot: "/tmp" };

describe("todo_write tool", () => {
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
    expect(todoWriteTool.name).toBe("todo_write");
  });
});
