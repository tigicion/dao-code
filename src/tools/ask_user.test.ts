import { describe, it, expect } from "vitest";
import { askUserTool } from "./ask_user.js";

describe("ask_user tool", () => {
  it("returns the user's answer via ctx.ask", async () => {
    const out = await askUserTool.handler(
      { question: "favorite color?" },
      { workspaceRoot: "/tmp", ask: async () => "blue" },
    );
    expect(out).toBe("blue");
  });

  it("passes the question to ctx.ask", async () => {
    let asked = "";
    await askUserTool.handler(
      { question: "which env?" },
      { workspaceRoot: "/tmp", ask: async (q) => { asked = q; return "prod"; } },
    );
    expect(asked).toBe("which env?");
  });

  it("returns a placeholder when the answer is empty", async () => {
    const out = await askUserTool.handler(
      { question: "x?" },
      { workspaceRoot: "/tmp", ask: async () => "   " },
    );
    expect(out).toBe("(用户未回答)");
  });

  it("throws when ask is not configured", async () => {
    await expect(
      askUserTool.handler({ question: "x?" }, { workspaceRoot: "/tmp" }),
    ).rejects.toThrow(/ask 未配置/);
  });

  it("declares auto approval", () => {
    expect(askUserTool.approval).toBe("auto");
    expect(askUserTool.name).toBe("ask_user");
  });
});
