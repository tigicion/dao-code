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

  it("斜杠命令面板:竖排显示命令 + 简介", async () => {
    const { lastFrame, stdin } = render(<App {...makeDeps()} />);
    for (const ch of "/mem") stdin.write(ch);
    await delay();
    const f = lastFrame()!;
    expect(f).toContain("/memory");
    expect(f).toContain("跨会话记忆"); // 简介(/memory 的描述)在右侧
  });

  it("skill 工具:加载成功显示 Skill(name) + 已加载技能", async () => {
    const { lastFrame, stdin } = render(
      <App {...makeDeps({
        submit: async (_t, { events }) => {
          events.toolResult(
            { id: "c1", type: "function" as const, function: { name: "skill", arguments: JSON.stringify({ name: "debugging" }) } },
            { role: "tool", tool_call_id: "c1", content: "# Skill: Systematic Debugging\n\n正文……" },
          );
          events.assistantDone({ role: "assistant", content: "ok" });
        },
      })} />,
    );
    for (const ch of "go") stdin.write(ch);
    await delay();
    stdin.write("\r");
    await delay();
    const f = lastFrame()!;
    expect(f).toContain("Skill(debugging)"); // 入参名(无命名空间)
    expect(f).toContain("已加载技能 Systematic Debugging"); // 从正文 # Skill: 取真实名
  });

  it("Tab 补全斜杠命令:唯一匹配补成全名+空格", async () => {
    let got = "";
    const { stdin } = render(
      <App {...makeDeps({ runCommand: (l) => { got = l; return { handled: true }; } })} />,
    );
    for (const ch of "/sess") stdin.write(ch); // 只键入前缀
    await delay();
    stdin.write("\t"); // Tab → 应补成 "/session "
    await delay();
    stdin.write("\r"); // Enter 提交
    await delay();
    expect(got.trim()).toBe("/session"); // 没补全的话会是 "/sess"
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

  it("edit_file 带 ```diff 块:渲染行号 + 上下文 + 增删", async () => {
    const diff = "```diff\n    1 import x\n-   2   return 1\n+   2   return 2\n    3 }\n```";
    const { lastFrame, stdin } = render(
      <App {...makeDeps({
        submit: async (_t, { events }) => {
          events.toolResult(
            { id: "c1", type: "function" as const, function: { name: "edit_file", arguments: JSON.stringify({ path: "a.ts", old_string: "  return 1", new_string: "  return 2" }) } },
            { role: "tool", tool_call_id: "c1", content: `已编辑 a.ts(替换 1 处,行 2)\n${diff}` },
          );
          events.assistantDone({ role: "assistant", content: "ok" });
        },
      })} />,
    );
    for (const ch of "go") stdin.write(ch);
    await delay();
    stdin.write("\r");
    await delay();
    const f = lastFrame()!;
    expect(f).toContain("import x"); // 上下文行
    expect(f).toContain("return 1"); // 删除行
    expect(f).toContain("return 2"); // 新增行
    expect(f).toContain("2"); // 行号
  });

  it("ctrl+o:默认折叠 read_file 输出,按键后展开完整内容", async () => {
    const { lastFrame, stdin } = render(
      <App {...makeDeps({
        submit: async (_t, { events }) => {
          events.toolResult(
            { id: "c1", type: "function" as const, function: { name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) } },
            { role: "tool", tool_call_id: "c1", content: "L1\nL2\nL3" },
          );
          events.assistantDone({ role: "assistant", content: "ok" });
        },
      })} />,
    );
    for (const ch of "go") stdin.write(ch);
    await delay();
    stdin.write("\r");
    await delay();
    let f = lastFrame()!;
    expect(f).toContain("读取 a.ts");
    expect(f).toContain("ctrl+o 展开"); // 折叠提示
    expect(f).not.toContain("L2"); // 默认不显示正文
    stdin.write("\x0f"); // Ctrl+O
    await delay();
    f = lastFrame()!;
    expect(f).toContain("L2"); // 展开后追加完整内容
  });

  it("推理思考留历史:assistantDone 时提交 ✻ 思考块", async () => {
    const { lastFrame, stdin } = render(
      <App {...makeDeps({
        submit: async (_t, { events }) => {
          events.reasoning("先看下结构");
          events.assistantDone({ role: "assistant", content: "好了" });
        },
      })} />,
    );
    for (const ch of "go") stdin.write(ch);
    await delay();
    stdin.write("\r");
    await delay();
    const f = lastFrame()!;
    expect(f).toContain("✻ 思考");
    expect(f).toContain("先看下结构");
    // 顺序:思考必须在答案之前
    expect(f.indexOf("先看下结构")).toBeLessThan(f.indexOf("好了"));
  });

  it("工具 ⎿ 子块:exec_shell 展示截断真实输出", async () => {
    const { lastFrame, stdin } = render(
      <App {...makeDeps({
        submit: async (_t, { events }) => {
          events.toolResult(
            { id: "c1", type: "function" as const, function: { name: "exec_shell", arguments: JSON.stringify({ command: "echo hi" }) } },
            { role: "tool", tool_call_id: "c1", content: "hi\nbye" },
          );
          events.assistantDone({ role: "assistant", content: "ok" });
        },
      })} />,
    );
    for (const ch of "go") stdin.write(ch);
    await delay();
    stdin.write("\r");
    await delay();
    const f = lastFrame()!;
    expect(f).toContain("⎿");
    expect(f).toContain("hi");
    expect(f).toContain("bye");
  });

  it("todo_write 渲染成复选框清单", async () => {
    const { lastFrame, stdin } = render(
      <App {...makeDeps({
        submit: async (_t, { events }) => {
          events.toolResult(
            { id: "c1", type: "function" as const, function: { name: "todo_write", arguments: "{}" } },
            { role: "tool", tool_call_id: "c1", content: "☑ 读代码\n▶ 写实现\n☐ 测试" },
          );
          events.assistantDone({ role: "assistant", content: "ok" });
        },
      })} />,
    );
    for (const ch of "go") stdin.write(ch);
    await delay();
    stdin.write("\r");
    await delay();
    const f = lastFrame()!;
    expect(f).toContain("☑ 读代码");
    expect(f).toContain("▶ 写实现");
    expect(f).toContain("☐ 测试");
  });

  it("verbose:工具结果显示原样参数", async () => {
    const { lastFrame, stdin } = render(
      <App {...makeDeps({
        verbose: true,
        submit: async (_t, { events }) => {
          events.toolResult(
            { id: "c1", type: "function" as const, function: { name: "read_file", arguments: JSON.stringify({ path: "src/foo.ts" }) } },
            { role: "tool", tool_call_id: "c1", content: "line1\nline2" },
          );
          events.assistantDone({ role: "assistant", content: "ok" });
        },
      })} />,
    );
    for (const ch of "go") stdin.write(ch);
    await delay();
    stdin.write("\r");
    await delay();
    const f = lastFrame()!;
    expect(f).toContain("参数");
    expect(f).toContain("src/foo.ts");
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

  it("并发审批排队,不互相覆盖(回归:并行外部读死锁)", async () => {
    let ap: ApprovalPrompt | null = null;
    const { stdin } = render(<App {...makeDeps({ register: ({ approvalPrompt }) => { ap = approvalPrompt; } })} />);
    await delay();
    const p1 = ap!([{ id: "a", toolName: "list_dir", capability: "read", summary: "list /tmp/x" }]);
    const p2 = ap!([{ id: "b", toolName: "list_dir", capability: "read", summary: "list /tmp/y" }]);
    await delay();
    stdin.write("y"); // 解决队首
    await delay();
    stdin.write("y"); // 解决后一个(此前会被覆盖丢失 → 死锁)
    await delay();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.get("a")).toBe("once");
    expect(r2.get("b")).toBe("once");
  });

  it("/theme 切换主题(App 内拦截)", async () => {
    const { lastFrame, stdin } = render(<App {...makeDeps()} />);
    for (const ch of "/theme") stdin.write(ch);
    await delay();
    stdin.write("\r");
    await delay();
    expect(lastFrame()).toContain("已切换主题");
  });

  it("@文件补全:Tab 补全第一个匹配", async () => {
    let submitted = "";
    const { stdin } = render(
      <App
        {...makeDeps({
          completeFiles: (p) => ["src/index.ts", "docs/x.md"].filter((f) => f.includes(p)),
          submit: async (t, { events }) => { submitted = t; events.assistantDone({ role: "assistant", content: "ok" }); },
        })}
      />,
    );
    for (const ch of "看 @src") stdin.write(ch);
    await delay();
    stdin.write("\t"); // Tab 补全
    await delay();
    stdin.write("\r");
    await delay();
    expect(submitted).toContain("@src/index.ts");
  });

  it("续跑:initialItems 渲染进 transcript", () => {
    const { lastFrame } = render(
      <App
        {...makeDeps({
          initialItems: [
            { id: 1, kind: "notice", text: "[已恢复上次会话]" },
            { id: 2, kind: "user", text: "上次的问题" },
            { id: 3, kind: "assistant", text: "上次的回答" },
          ],
        })}
      />,
    );
    const f = lastFrame()!;
    expect(f).toContain("已恢复上次会话");
    expect(f).toContain("上次的问题");
    expect(f).toContain("上次的回答");
  });

  it("工具展示:意图标签 + 一行小结(读取 path · N 行),不显示工具名", async () => {
    const { lastFrame, stdin } = render(
      <App
        {...makeDeps({
          submit: async (_t, { events }) => {
            events.toolResult(
              { id: "c1", type: "function" as const, function: { name: "read_file", arguments: JSON.stringify({ path: "src/foo.ts" }) } },
              { role: "tool", tool_call_id: "c1", content: "line1\nline2\nline3" },
            );
            events.assistantDone({ role: "assistant", content: "ok" });
          },
        })}
      />,
    );
    for (const ch of "go") stdin.write(ch);
    await delay();
    stdin.write("\r");
    await delay();
    const f = lastFrame()!;
    expect(f).toContain("读取 src/foo.ts");
    expect(f).toContain("3 行");
    expect(f).not.toContain("read_file");
  });

  it("运行中回车排队 → 当前回合结束后按序处理(steering)", async () => {
    let resolveFirst!: () => void;
    const submitted: string[] = [];
    const { stdin } = render(
      <App
        {...makeDeps({
          submit: async (t, { events }) => {
            submitted.push(t);
            if (submitted.length === 1) await new Promise<void>((r) => { resolveFirst = r; });
            events.assistantDone({ role: "assistant", content: "done" });
          },
        })}
      />,
    );
    for (const ch of "go") stdin.write(ch);
    await delay();
    stdin.write("\r"); // 第一回合开始(busy)
    await delay();
    for (const ch of "next") stdin.write(ch);
    await delay();
    stdin.write("\r"); // 运行中 → 排队
    await delay();
    resolveFirst(); // 第一回合结束 → 处理排队
    await delay();
    await delay();
    expect(submitted).toEqual(["go", "next"]);
  });

  it("Coordinator 模式 → 状态栏显示标识", () => {
    const { lastFrame } = render(
      <App
        {...makeDeps({
          getStatus: () => ({ model: "m", mode: "normal", promptTokens: 0, completionTokens: 0, cacheHitRatio: 0, yolo: true, coordinator: true, contextPct: 0 }),
        })}
      />,
    );
    expect(lastFrame()).toContain("Coordinator");
  });

  it("后台任务通知 → 自动作为新回合处理(注入结果)", async () => {
    const notes = ["<task-notification>结果ABC</task-notification>"];
    const submitted: string[] = [];
    const { lastFrame } = render(
      <App
        {...makeDeps({
          drainNotifications: () => notes.splice(0),
          subscribeTasks: () => {},
          runningTasks: () => 0,
          submit: async (t, { events }) => { submitted.push(t); events.assistantDone({ role: "assistant", content: "已处理" }); },
        })}
      />,
    );
    await delay();
    await delay();
    expect(submitted.some((s) => s.includes("结果ABC"))).toBe(true);
    expect(lastFrame()).toContain("收到");
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

  it("Tab 补全 /audit(唯一前缀)", async () => {
    let got = "";
    const { stdin } = render(
      <App {...makeDeps({ runCommand: (l) => { got = l; return { handled: true }; } })} />,
    );
    for (const ch of "/aud") stdin.write(ch);
    await delay();
    stdin.write("\t");
    await delay();
    stdin.write("\r");
    await delay();
    expect(got.trim()).toBe("/audit");
  });
});
