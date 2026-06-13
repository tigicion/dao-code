import { describe, it, expect } from "vitest";
import { messageParentTool } from "./message_parent.js";

describe("message_parent 工具", () => {
  it("有 messageParent → 调用并回执", async () => {
    const sent: string[] = [];
    const ctx = { workspaceRoot: "/tmp", readFiles: new Set<string>(), messageParent: (m: string) => sent.push(m) } as any;
    const r = await messageParentTool.handler({ message: "进度:1/3" } as any, ctx);
    expect(sent).toEqual(["进度:1/3"]);
    expect(r).toContain("已发送");
  });
  it("无 messageParent(非后台子代理)→ 友好提示,不报错", async () => {
    const ctx = { workspaceRoot: "/tmp", readFiles: new Set<string>() } as any;
    const r = await messageParentTool.handler({ message: "x" } as any, ctx);
    expect(r).toContain("你不是后台子代理");
  });
});
