import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { App } from "./App.js";
import type { AppDeps } from "./types.js";
import type { ApprovalDecision, ApprovalPrompt } from "../../approval/types.js";

const delay = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function makeDeps(over: Partial<AppDeps> = {}): AppDeps {
  return {
    welcome: {
      info: { model: "deepseek-v4-pro", thinking: "max", cwd: "/x/y/z", version: "0.1.0", branch: "main" },
      caps: { tier: "none", isTTY: true, columns: 80 },
      bg: "dark",
      maxim: { text: "上善若水", chapter: 8 },
    },
    submit: async (text, { events }) => {
      events.assistantDone({ role: "assistant", content: "echo: " + text });
    },
    runCommand: (line) =>
      line.startsWith("/help") ? { handled: true, output: "命令:/help /exit" } : { handled: true, output: "未知" },
    compact: async () => {},
    getStatus: () => ({ model: "deepseek-v4-pro", mode: "normal", promptTokens: 12, completionTokens: 3, cacheHitRatio: 0.5, yolo: false, branch: "main", contextPct: 0.3 }),
    register: () => {},
    ...over,
  };
}

describe("App", () => {
  it("欢迎屏 + 状态栏初始渲染", () => {
    const { lastFrame } = render(<App {...makeDeps()} />);
    const f = lastFrame()!;
    expect(f).toContain("DAO CODE");
    expect(f).toContain("deepseek-v4-pro");
    expect(f).toContain("缓存命中 50%");
  });

  it("输入消息回车 → 用户条目 + 助手回复进 transcript", async () => {
    const { lastFrame, stdin } = render(<App {...makeDeps()} />);
    stdin.write("hi");
    await delay();
    stdin.write("\r"); // Enter
    await delay();
    const f = lastFrame()!;
    expect(f).toContain("hi");
    expect(f).toContain("echo: hi");
  });

  it("斜杠命令走 runCommand,输出作 notice", async () => {
    let got = "";
    const { lastFrame, stdin } = render(
      <App {...makeDeps({ runCommand: (l) => { got = l; return { handled: true, output: "命令:/help /exit" }; } })} />,
    );
    for (const ch of "/help") stdin.write(ch);
    await delay();
    stdin.write("\r");
    await delay();
    expect(got).toBe("/help");
    expect(lastFrame()!).toContain("命令:/help /exit");
  });

  it("edit_file 工具结果渲染红绿 diff(路径 + 增删行)", async () => {
    const { lastFrame, stdin } = render(
      <App
        {...makeDeps({
          submit: async (_t, { events }) => {
            events.toolResult(
              {
                id: "c1",
                type: "function" as const,
                function: { name: "edit_file", arguments: JSON.stringify({ path: "a.ts", old_string: "旧行", new_string: "新行A\n新行B" }) },
              },
              { role: "tool", tool_call_id: "c1", content: "已编辑 a.ts(替换 1 处)" },
            );
            events.assistantDone({ role: "assistant", content: "完成" });
          },
        })}
      />,
    );
    for (const ch of "go") stdin.write(ch);
    await delay();
    stdin.write("\r");
    await delay();
    const f = lastFrame()!;
    expect(f).toContain("a.ts");
    expect(f).toContain("- 旧行");
    expect(f).toContain("+ 新行A");
    expect(f).toContain("+ 新行B");
  });

  it("光标行内编辑:左移两次后插入字符", async () => {
    let submitted = "";
    const { stdin } = render(
      <App {...makeDeps({ submit: async (t, { events }) => { submitted = t; events.assistantDone({ role: "assistant", content: "ok" }); } })} />,
    );
    for (const ch of "abc") stdin.write(ch);
    await delay();
    stdin.write("\x1B[D"); // ←
    stdin.write("\x1B[D"); // ← 光标到 a|bc
    await delay();
    stdin.write("X"); // aXbc
    await delay();
    stdin.write("\r");
    await delay();
    expect(submitted).toBe("aXbc");
  });

  it("审批模态:弹出 → 按键 → resolve 决定", async () => {
    let ap: ApprovalPrompt | null = null;
    let resolved: Map<string, ApprovalDecision> | null = null;
    const { lastFrame, stdin } = render(
      <App
        {...makeDeps({
          register: ({ approvalPrompt }) => { ap = approvalPrompt; },
          submit: async () => {
            resolved = await ap!([{ id: "1", toolName: "write_file", capability: "write", summary: "write_file a.txt" }]);
          },
        })}
      />,
    );
    for (const ch of "go") stdin.write(ch);
    await delay();
    stdin.write("\r");
    await delay();
    expect(lastFrame()).toContain("需要批准");
    stdin.write("y");
    await delay();
    expect(resolved!.get("1")).toBe("once");
  });

  it("/theme 切换主题(App 内拦截)", async () => {
    const { lastFrame, stdin } = render(<App {...makeDeps()} />);
    for (const ch of "/theme") stdin.write(ch);
    await delay();
    stdin.write("\r");
    await delay();
    expect(lastFrame()).toContain("已切换主题");
  });

  it("submit 抛错 → 显示出错 notice,不崩", async () => {
    const { lastFrame, stdin } = render(
      <App {...makeDeps({ submit: async () => { throw new Error("boom"); } })} />,
    );
    for (const ch of "go") stdin.write(ch);
    await delay();
    stdin.write("\r");
    await delay();
    expect(lastFrame()!).toContain("出错:boom");
  });
});
