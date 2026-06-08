import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { App } from "./App.js";
import type { AppDeps } from "./types.js";

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
    getStatus: () => ({ model: "deepseek-v4-pro", mode: "normal", promptTokens: 12, completionTokens: 3, cacheHitRatio: 0.5, yolo: false }),
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
