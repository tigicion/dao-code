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

  it("routes to ctx.askChoice (↑↓+Enter 选择器) when options are given", async () => {
    let askedOpts: string[] = [];
    const out = await askUserTool.handler(
      { question: "选哪个方案?", options: ["方案 A", "方案 B"] },
      {
        workspaceRoot: "/tmp",
        ask: async () => "不该走到这",
        askChoice: async (_q, opts) => { askedOpts = opts; return "方案 B"; },
      },
    );
    expect(out).toBe("方案 B");
    expect(askedOpts).toEqual(["方案 A", "方案 B"]);
  });

  it("falls back to ctx.ask (free text) when askChoice is unavailable", async () => {
    const out = await askUserTool.handler(
      { question: "选哪个?", options: ["A", "B"] },
      { workspaceRoot: "/tmp", ask: async () => "我自己写一个" },
    );
    expect(out).toBe("我自己写一个");
  });

  it("declares auto approval", () => {
    expect(askUserTool.approval).toBe("auto");
    expect(askUserTool.name).toBe("ask_user");
  });
});
