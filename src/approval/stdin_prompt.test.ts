import { describe, it, expect } from "vitest";
import { makeApprovalPrompt } from "./stdin_prompt.js";
import type { ApprovalRequest } from "./types.js";

const req = (id: string): ApprovalRequest => ({ id, toolName: "Bash", capability: "exec", summary: `$ cmd-${id}` });

describe("makeApprovalPrompt", () => {
  it("非交互(isInteractive=false)时直接拒绝,完全不调用 ask——避免在无 TTY 环境卡死等一个永远不会来的回答", async () => {
    let askCalled = false;
    const ask = async () => { askCalled = true; return "y"; }; // 就算真调用了也回 "y",用来反证真的没调用
    const prompt = makeApprovalPrompt(ask, false);
    const decisions = await prompt([req("1"), req("2")]);
    expect(askCalled).toBe(false);
    expect(decisions.get("1")).toBe("deny");
    expect(decisions.get("2")).toBe("deny");
  });

  it("交互(isInteractive=true)时正常读 ask 的回答", async () => {
    const answers = ["y", "a", "n", "garbage"];
    let i = 0;
    const ask = async () => answers[i++]!;
    const prompt = makeApprovalPrompt(ask, true);
    const decisions = await prompt([req("1"), req("2"), req("3"), req("4")]);
    expect(decisions.get("1")).toBe("once");
    expect(decisions.get("2")).toBe("always");
    expect(decisions.get("3")).toBe("deny");
    expect(decisions.get("4")).toBe("deny"); // 非 y/a 的任何回答都当拒绝,不只是 "n"
  });

  it("空请求列表不调用 ask,返回空 Map", async () => {
    let askCalled = false;
    const ask = async () => { askCalled = true; return "y"; };
    const prompt = makeApprovalPrompt(ask, true);
    const decisions = await prompt([]);
    expect(askCalled).toBe(false);
    expect(decisions.size).toBe(0);
  });
});
