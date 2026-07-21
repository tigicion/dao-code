import React from "react";
import { describe, it, expect, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { App } from "./App.js";
import type { AppDeps } from "./types.js";
import type { ContentPart } from "../../client/types.js";
import type { ApprovalDecision, ApprovalPrompt } from "../../approval/types.js";
import { setLang } from "../../i18n/i18n.js";

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
  // 默认跑中文(断言中文文案的用例据此);需要英文的用例在自身内 setLang("en")。
  beforeEach(() => setLang("zh"));

  it("欢迎屏 + 状态栏初始渲染", () => {
    setLang("zh");
    const { lastFrame } = render(<App {...makeDeps()} />);
    const f = lastFrame()!;
    expect(f).toContain("DAO CODE");
    expect(f).toContain("deepseek-v4-pro");
    expect(f).toContain("缓存命中 50%");
  });

  it("状态栏显示版本号和会话 id", () => {
    setLang("zh");
    const { lastFrame } = render(
      <App
        {...makeDeps({
          getStatus: () => ({
            model: "deepseek-v4-pro", mode: "normal", promptTokens: 12, completionTokens: 3,
            cacheHitRatio: 0.5, yolo: false, contextPct: 0.3, version: "0.4.10", sessionId: "20260719-200800-h2w9",
          }),
        })}
      />,
    );
    const f = lastFrame()!;
    expect(f).toContain("v0.4.10");
    expect(f).toContain("20260719-200800-h2w9");
  });

  it("skips the welcome banner when skipBanner is set", () => {
    const { lastFrame } = render(<App {...makeDeps({ skipBanner: true })} />);
    expect(lastFrame()).not.toContain("DAO CODE");
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
            { id: "c1", type: "function" as const, function: { name: "Skill", arguments: JSON.stringify({ name: "debugging" }) } },
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

  it("/resume 无参:弹出会话选择器,↑↓ 选择 + ⏎ 载入", async () => {
    let resumed = "";
    const { lastFrame, stdin } = render(
      <App {...makeDeps({
        listResume: () => [{ id: "s1", label: "s1 — 第一个" }, { id: "s2", label: "s2 ·未完成" }],
        runCommand: (l) => {
          if (l.startsWith("/resume ")) {
            resumed = l;
            return { handled: true, output: "✓ 已载入会话 s2,继续写入当前会话。", clearTranscript: true,
              resumeItems: [
                { id: 0, kind: "notice", text: "── 会话 s2 最近对话(共 8 条消息,显示末 2 条)──" },
                { id: 0, kind: "user", text: "上次问题：登录为何 500" },
                { id: 0, kind: "assistant", text: "上次结论：是 token 过期" },
              ] };
          }
          return { handled: true };
        },
      })} />,
    );
    for (const ch of "/resume") stdin.write(ch);
    await delay();
    stdin.write("\r"); // 提交 /resume → 开选择器
    await delay();
    const f = lastFrame()!;
    expect(f).toContain("载入历史会话");
    expect(f).toContain("s1 — 第一个");
    expect(f).toContain("s2 ·未完成");
    stdin.write("\x1b[B"); // ↓ 移到 s2
    await delay();
    stdin.write("\r"); // ⏎ 载入
    await delay();
    const g = lastFrame()!;
    expect(resumed).toBe("/resume s2"); // 选中第二项载入,无需再输命令
    expect(g).toContain("已载入会话");
    expect(g).toContain("最近对话"); // 回顾头
    expect(g).toContain("上次结论：是 token 过期"); // 重放末段对话 → 知道上次做到哪
  });

  it("/account 无参:弹账户选择器,↓ + ⏎ 切换", async () => {
    let switched = "";
    const { lastFrame, stdin } = render(
      <App {...makeDeps({
        listAccounts: () => [
          { name: "personal", active: true, detail: "deepseek/v4-pro · 钥匙串" },
          { name: "work", active: false, detail: "deepseek/v4-pro · 文件" },
        ],
        switchAccount: (n) => { switched = n; },
      })} />,
    );
    for (const ch of "/account") stdin.write(ch);
    await delay();
    stdin.write("\r");
    await delay();
    const f = lastFrame()!;
    expect(f).toContain("账户:");
    expect(f).toContain("personal");
    expect(f).toContain("work");
    expect(f).toContain("➕ 添加新账户");
    expect(f).toContain("🗑 删除账户");
    stdin.write("\x1b[B"); // ↓ 到 work
    await delay();
    stdin.write("\r"); // ⏎ 切换
    await delay();
    expect(switched).toBe("work");
    expect(lastFrame()!).toContain("已切到账户「work」");
  });

  it("/account 无账户:直接进入添加引导,先问 provider", async () => {
    const { lastFrame, stdin } = render(
      <App {...makeDeps({ listAccounts: () => [], addAccount: async () => ({ ok: true, name: "default" }) })} />,
    );
    for (const ch of "/account") stdin.write(ch);
    await delay();
    stdin.write("\r");
    await delay();
    expect(lastFrame()!).toContain("哪个 provider");
  });

  it("/account 添加账户:provider 选择器(数字键选)→ key → name,provider 透传给 addAccount 且粘贴提示带上 provider 标签", async () => {
    let seenProvider: string | undefined;
    const { lastFrame, stdin } = render(
      <App {...makeDeps({
        listAccounts: () => [],
        addAccount: async (key, name, provider) => { seenProvider = provider; return { ok: true, name: name ?? "default" }; },
      })} />,
    );
    for (const ch of "/account") stdin.write(ch);
    await delay();
    stdin.write("\r"); // 无账户,直接进添加
    await delay();
    expect(lastFrame()!).toContain("千帆 token plan"); // 选择器里列出候选,不用打字
    stdin.write("2"); // 数字键直接选第 2 项:qianfan
    await delay();
    expect(lastFrame()!).toContain("千帆 token plan"); // 粘贴提示报出选中的 provider,不再写死 DeepSeek
    for (const ch of "qf-key") stdin.write(ch);
    await delay();
    stdin.write("\r"); // 粘贴 key
    await delay();
    stdin.write("\r"); // 起名(留空用默认)
    await delay();
    expect(seenProvider).toBe("qianfan");
  });

  it("/account 添加账户:↓↓ + ⏎ 选到 volcengine(排最后)", async () => {
    let seenProvider: string | undefined;
    const { stdin } = render(
      <App {...makeDeps({
        listAccounts: () => [],
        addAccount: async (key, name, provider) => { seenProvider = provider; return { ok: true, name: name ?? "default" }; },
      })} />,
    );
    for (const ch of "/account") stdin.write(ch);
    await delay();
    stdin.write("\r");
    await delay();
    stdin.write("\x1b[B"); // ↓ 到 qianfan
    await delay();
    stdin.write("\x1b[B"); // ↓ 到 volcengine
    await delay();
    stdin.write("\r"); // ⏎ 确认
    await delay();
    for (const ch of "vk-key") stdin.write(ch);
    await delay();
    stdin.write("\r");
    await delay();
    stdin.write("\r");
    await delay();
    expect(seenProvider).toBe("volcengine");
  });

  it("/account 添加账户:provider 选择器按 Esc → 取消,不调用 addAccount", async () => {
    let called = false;
    const { lastFrame, stdin } = render(
      <App {...makeDeps({
        listAccounts: () => [],
        addAccount: async (key, name, provider) => { called = true; return { ok: true, name: name ?? "default" }; },
      })} />,
    );
    for (const ch of "/account") stdin.write(ch);
    await delay();
    stdin.write("\r");
    await delay();
    stdin.write("\x1b"); // Esc
    await delay();
    expect(called).toBe(false);
    expect(lastFrame()!).toContain("已取消");
  });

  it("/account → 🗑 删除 → 选中账户删除", async () => {
    let removed = "";
    const { lastFrame, stdin } = render(
      <App {...makeDeps({
        listAccounts: () => [
          { name: "aaa", active: true, detail: "x" },
          { name: "bbb", active: false, detail: "y" },
        ],
        removeAccount: (n) => { removed = n; },
      })} />,
    );
    for (const ch of "/account") stdin.write(ch);
    await delay();
    stdin.write("\r"); // 开选择器
    await delay();
    for (let i = 0; i < 3; i++) { stdin.write("\x1b[B"); await delay(8); } // 移到 🗑(行 aaa,bbb,➕,🗑)
    stdin.write("\r"); // 进删除模式
    await delay();
    expect(lastFrame()!).toContain("删除哪个账户");
    stdin.write("\r"); // 删第一个 aaa
    await delay();
    expect(removed).toBe("aaa");
  });

  it("/model 无参:弹选择器,↓ + ⏎ 选中 → 复用 runCommand 落地", async () => {
    let ran = "";
    const { lastFrame, stdin } = render(
      <App {...makeDeps({
        listModels: () => [
          { model: "deepseek-v4-pro", active: true },
          { model: "deepseek-v4-flash", active: false },
        ],
        runCommand: (line) => {
          ran = line;
          return { handled: true, output: `已切换模型:${line.split(" ")[1]}` };
        },
      })} />,
    );
    for (const ch of "/model") stdin.write(ch);
    await delay();
    stdin.write("\r"); // 开选择器
    await delay();
    const f = lastFrame()!;
    expect(f).toContain("deepseek-v4-pro");
    expect(f).toContain("deepseek-v4-flash");
    stdin.write("\x1b[B"); // ↓ 到 flash
    await delay();
    stdin.write("\r"); // ⏎ 选中
    await delay();
    expect(ran).toBe("/model deepseek-v4-flash");
    expect(lastFrame()!).toContain("已切换模型:deepseek-v4-flash");
  });

  it("/model 选择器:Esc 取消不触发 runCommand", async () => {
    let called = false;
    const { stdin } = render(
      <App {...makeDeps({
        listModels: () => [
          { model: "deepseek-v4-pro", active: true },
          { model: "deepseek-v4-flash", active: false },
        ],
        runCommand: (line) => { if (line.startsWith("/model ")) called = true; return { handled: true, output: "未知" }; },
      })} />,
    );
    for (const ch of "/model") stdin.write(ch);
    await delay();
    stdin.write("\r");
    await delay();
    stdin.write("\x1b"); // Esc
    await delay();
    expect(called).toBe(false);
  });

  it("/skills 无参:默认只列第三方,⏎ 切换选中;按 t 显示内置", async () => {
    let toggled: [string, boolean] | null = null;
    const { lastFrame, stdin } = render(
      <App {...makeDeps({
        listSkills: () => [
          { name: "tdd", on: true, source: "内置", detail: "测试先行" },
          { name: "my-skill", on: true, source: "用户", detail: "自定义" },
        ],
        setSkillEnabled: (n, on) => { toggled = [n, on]; },
      })} />,
    );
    for (const ch of "/skills") stdin.write(ch);
    await delay();
    stdin.write("\r"); // 开选择器
    await delay();
    const f = lastFrame()!;
    expect(f).toContain("技能(内置 1 · 第三方 1");
    expect(f).toContain("仅第三方");
    expect(f).toContain("my-skill"); // 第三方显示
    expect(f).not.toContain("tdd");  // 内置默认隐藏
    expect(f).toContain("t 显/隐内置"); // 快捷键提示
    stdin.write("\r"); // ⏎ 切换可见的第一个(my-skill)→ 关
    await delay();
    expect(toggled).toEqual(["my-skill", false]);
    stdin.write("t"); // 显示内置
    await delay();
    expect(lastFrame()!).toContain("tdd");
  });

  it("/skills 选择器:快捷键 I 关闭全部安装,b 开启全部内置", async () => {
    const batches: [string, boolean][] = [];
    const { stdin } = render(
      <App {...makeDeps({
        listSkills: () => [{ name: "my-skill", on: true, source: "用户", detail: "x" }],
        batchSkills: (scope, on) => { batches.push([scope, on]); },
      })} />,
    );
    for (const ch of "/skills") stdin.write(ch);
    await delay();
    stdin.write("\r"); // 开选择器
    await delay();
    stdin.write("I"); // 关闭全部安装
    await delay();
    stdin.write("b"); // 开启全部内置
    await delay();
    expect(batches).toContainEqual(["installed", false]);
    expect(batches).toContainEqual(["bundled", true]);
  });

  it("/resume 无参 + 无历史会话:提示而不开选择器", async () => {
    const { lastFrame, stdin } = render(<App {...makeDeps({ listResume: () => [] })} />);
    for (const ch of "/resume") stdin.write(ch);
    await delay();
    stdin.write("\r");
    await delay();
    expect(lastFrame()!).toContain("本工作区无历史会话");
  });

  it("选择器:剥离选项自带的 A)/枚举,避免与界面编号 1. 2. 叠加", async () => {
    let ask: ((q: string, options: string[], multi?: boolean) => Promise<string>) | null = null;
    const { lastFrame } = render(<App {...makeDeps({ register: ({ askChoice }) => { ask = askChoice; } })} />);
    await delay();
    void ask!("贴纸拖动方式?", ["A) 拖拽模式", "B) 先选后放", "C) 纯画布"]);
    await delay();
    const f = lastFrame()!;
    expect(f).toContain("1. 拖拽模式"); // 界面编号保留,模型自带的 "A) " 被剥离
    expect(f).toContain("2. 先选后放");
    expect(f).not.toContain("A)"); // 不再出现 "1. A) …" 这种叠加
  });

  it("Edit 工具结果渲染红绿 diff(路径 + 增删行)", async () => {
    const { lastFrame, stdin } = render(
      <App
        {...makeDeps({
          submit: async (_t, { events }) => {
            events.toolResult(
              {
                id: "c1",
                type: "function" as const,
                function: { name: "Edit", arguments: JSON.stringify({ path: "a.ts", old_string: "旧行", new_string: "新行A\n新行B" }) },
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

  it("Edit 带 ```diff 块:渲染行号 + 上下文 + 增删", async () => {
    const diff = "```diff\n    1 import x\n-   2   return 1\n+   2   return 2\n    3 }\n```";
    const { lastFrame, stdin } = render(
      <App {...makeDeps({
        submit: async (_t, { events }) => {
          events.toolResult(
            { id: "c1", type: "function" as const, function: { name: "Edit", arguments: JSON.stringify({ path: "a.ts", old_string: "  return 1", new_string: "  return 2" }) } },
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

  it("ctrl+o:默认折叠 Read 输出,按键后展开完整内容", async () => {
    const { lastFrame, stdin } = render(
      <App {...makeDeps({
        submit: async (_t, { events }) => {
          events.toolResult(
            { id: "c1", type: "function" as const, function: { name: "Read", arguments: JSON.stringify({ path: "a.ts" }) } },
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

  it("工具 ⎿ 子块:Bash 展示截断真实输出", async () => {
    const { lastFrame, stdin } = render(
      <App {...makeDeps({
        submit: async (_t, { events }) => {
          events.toolResult(
            { id: "c1", type: "function" as const, function: { name: "Bash", arguments: JSON.stringify({ command: "echo hi" }) } },
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

  it("Bash [exit 0] 是噪音,不展示;非零 exit 有信息量,照常展示", async () => {
    const { lastFrame, stdin } = render(
      <App {...makeDeps({
        submit: async (_t, { events }) => {
          events.toolResult(
            { id: "c1", type: "function" as const, function: { name: "Bash", arguments: JSON.stringify({ command: "echo hi" }) } },
            { role: "tool", tool_call_id: "c1", content: "hi\n[exit 0]" },
          );
          events.toolResult(
            { id: "c2", type: "function" as const, function: { name: "Bash", arguments: JSON.stringify({ command: "false" }) } },
            { role: "tool", tool_call_id: "c2", content: "[exit 1]" },
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
    expect(f).toContain("hi");
    expect(f).not.toContain("[exit 0]");
    expect(f).toContain("[exit 1]");
  });

  it("TodoWrite 渲染成复选框清单", async () => {
    const { lastFrame, stdin } = render(
      <App {...makeDeps({
        submit: async (_t, { events }) => {
          events.toolResult(
            { id: "c1", type: "function" as const, function: { name: "TodoWrite", arguments: "{}" } },
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
            { id: "c1", type: "function" as const, function: { name: "Read", arguments: JSON.stringify({ path: "src/foo.ts" }) } },
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
      <App {...makeDeps({ submit: async (t: string | ContentPart[], { events }) => { submitted = typeof t === "string" ? t : "[image]"; events.assistantDone({ role: "assistant", content: "ok" }); } })} />,
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
            resolved = await ap!([{ id: "1", toolName: "Write", capability: "write", summary: "Write a.txt" }]);
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
    const p1 = ap!([{ id: "a", toolName: "ListDir", capability: "read", summary: "list /tmp/x" }]);
    const p2 = ap!([{ id: "b", toolName: "ListDir", capability: "read", summary: "list /tmp/y" }]);
    await delay();
    stdin.write("y"); // 解决队首
    await delay();
    stdin.write("y"); // 解决后一个(此前会被覆盖丢失 → 死锁)
    await delay();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.get("a")).toBe("once");
    expect(r2.get("b")).toBe("once");
  });

  it("Ctrl+C 首次按下不退出,提示再按一次", async () => {
    const { lastFrame, stdin } = render(<App {...makeDeps()} />);
    await delay();
    stdin.write("\x03"); // Ctrl+C
    await delay();
    expect(lastFrame()).toContain("再按一次 Ctrl+C 退出");
    // 应用仍存活、仍响应输入(没有因为单次 Ctrl+C 就退出)。
    stdin.write("h");
    await delay();
    expect(lastFrame()).toContain("h");
  });

  it("Ctrl+C 两连按(2s 内)才真正退出", async () => {
    const { lastFrame, stdin } = render(<App {...makeDeps()} />);
    await delay();
    stdin.write("\x03");
    await delay();
    expect(lastFrame()).toContain("再按一次 Ctrl+C 退出"); // 武装态确认建立
    stdin.write("\x03");
    await delay();
    // Ink 的 exit() 触发真实 unmount,输出被清空成近乎空白帧——跟"仍在正常渲染"截然不同,
    // 不是巧合的文案消失(比如只是提示超时了)。
    expect(lastFrame()!.trim().length).toBeLessThan(5);
  });

  it("审批模态弹出时触发桌面通知,让切走的用户知道 dao 在等确认", async () => {
    let ap: ApprovalPrompt | null = null;
    const notified: [string, string][] = [];
    render(
      <App
        {...makeDeps({
          register: ({ approvalPrompt }) => { ap = approvalPrompt; },
          notify: (title, message) => { notified.push([title, message]); },
        })}
      />,
    );
    await delay();
    void ap!([{ id: "1", toolName: "Write", capability: "write", summary: "Write a.txt" }]);
    await delay();
    expect(notified).toHaveLength(1);
    expect(notified[0]![0]).toBe("dao");
    expect(notified[0]![1]).toContain("Write");
  });

  it("AskUserQuestion 问题弹出时触发桌面通知", async () => {
    let ask: ((q: string) => Promise<string>) | null = null;
    const notified: [string, string][] = [];
    render(
      <App
        {...makeDeps({
          register: ({ askUser }) => { ask = askUser; },
          notify: (title, message) => { notified.push([title, message]); },
        })}
      />,
    );
    await delay();
    void ask!("要不要覆盖已有文件?");
    await delay();
    expect(notified).toHaveLength(1);
    expect(notified[0]![0]).toBe("dao");
    expect(notified[0]![1]).toContain("要不要覆盖已有文件?");
  });

  it("ask_choice 选择弹出时触发桌面通知", async () => {
    let ask: ((q: string, options: string[], multi?: boolean) => Promise<string>) | null = null;
    const notified: [string, string][] = [];
    render(
      <App
        {...makeDeps({
          register: ({ askChoice }) => { ask = askChoice; },
          notify: (title, message) => { notified.push([title, message]); },
        })}
      />,
    );
    await delay();
    void ask!("选哪个方案?", ["A", "B"]);
    await delay();
    expect(notified).toHaveLength(1);
    expect(notified[0]![0]).toBe("dao");
    expect(notified[0]![1]).toContain("选哪个方案?");
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
          submit: async (t: string | ContentPart[], { events }) => { submitted = typeof t === "string" ? t : "[img]"; events.assistantDone({ role: "assistant", content: "ok" }); },
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
              { id: "c1", type: "function" as const, function: { name: "Read", arguments: JSON.stringify({ path: "src/foo.ts" }) } },
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
    expect(f).not.toContain("Read");
  });

  it("运行中回车排队 → 由 events.userMessage 在回合内直接消费,不用等整个回合结束(steering)", async () => {
    const steeringQueue: string[] = []; // 模拟 index.ts 的真实排队队列(不是 App 自己的本地镜像)
    let resolveGate!: () => void;
    const submitted: string[] = [];
    const { lastFrame, stdin } = render(
      <App
        {...makeDeps({
          submit: async (t: string | ContentPart[], { events }) => {
            submitted.push(typeof t === "string" ? t : "[img]");
            await new Promise<void>((r) => { resolveGate = r; }); // 模拟卡在某个工具轮里
            // 模拟 loop.ts 的 drainPending:在【同一个】回合内消费掉排队输入,不产生新的 submit 调用
            for (const m of steeringQueue.splice(0)) events.userMessage?.(m);
            events.assistantDone({ role: "assistant", content: "done" });
          },
          queueSteering: (text) => steeringQueue.push(text),
          drainSteering: () => steeringQueue.splice(0),
        })}
      />,
    );
    for (const ch of "go") stdin.write(ch);
    await delay();
    stdin.write("\r"); // 第一回合开始(busy)
    await delay();
    for (const ch of "next") stdin.write(ch);
    await delay();
    stdin.write("\r"); // 运行中 → 直接进真实队列,不等回合结束
    await delay();
    expect(steeringQueue).toEqual(["next"]);
    resolveGate(); // 放行,模拟"下一个工具轮"到达 drainPending
    await delay();
    await delay();
    expect(submitted).toEqual(["go"]); // 全程只有一次 submit 调用——"next" 没有另开一个新回合
    expect(lastFrame()!).toContain("next"); // userMessage 事件把它渲染成了真正的 user 消息
  });

  it("ESC:排队未消费时先取消排队、不打断当前回合;再按一次才真正中断", async () => {
    const steeringQueue: string[] = [];
    let sawAbort = false;
    const { lastFrame, stdin } = render(
      <App
        {...makeDeps({
          submit: async (t, { signal }) =>
            new Promise<void>((_resolve, reject) => {
              signal.addEventListener("abort", () => { sawAbort = true; reject(new Error("aborted")); });
            }),
          queueSteering: (text) => steeringQueue.push(text),
          drainSteering: () => steeringQueue.splice(0),
        })}
      />,
    );
    for (const ch of "go") stdin.write(ch);
    await delay();
    stdin.write("\r"); // 回合开始(永不自行结束,靠 abort 收尾)
    await delay();
    for (const ch of "next") stdin.write(ch);
    await delay();
    stdin.write("\r"); // 排队
    await delay();
    expect(steeringQueue).toEqual(["next"]);

    stdin.write("\x1b"); // 第一次 ESC:只取消排队
    await delay();
    expect(steeringQueue).toEqual([]); // 真实队列被清空
    expect(sawAbort).toBe(false); // 当前回合没被打断
    // 取消的内容没有回填进输入框:运行中的空输入框固定渲染成 "⏎ ▎"(busy 态提示符 + 空文本 + 光标)。
    expect(lastFrame()!).toContain("⏎ ▎");

    stdin.write("\x1b"); // 第二次 ESC:真正中断当前回合
    await delay();
    expect(sawAbort).toBe(true);
  });

  it("Ctrl+B:有前台调用时触发转后台并提示数量", async () => {
    let convertCalls = 0;
    const { lastFrame, stdin } = render(
      <App {...makeDeps({
        submit: async () => new Promise(() => {}), // 模拟一直不 resolve 的进行中回合(busy=true)
        convertForegroundToBackground: () => { convertCalls++; return 2; },
      })} />,
    );
    for (const ch of "go") stdin.write(ch);
    await delay();
    stdin.write("\r"); // 提交,进入 busy
    await delay();
    stdin.write("\x02"); // Ctrl+B
    await delay();
    expect(convertCalls).toBe(1);
    const f = lastFrame()!;
    expect(f).toContain("已将 2 个前台调用转为后台");
  });

  it("Ctrl+B:没有前台调用在跑(convertForegroundToBackground 返回 0)时不提示、不报错", async () => {
    let convertCalls = 0;
    const { lastFrame, stdin } = render(
      <App {...makeDeps({
        submit: async () => new Promise(() => {}),
        convertForegroundToBackground: () => { convertCalls++; return 0; },
      })} />,
    );
    for (const ch of "go") stdin.write(ch);
    await delay();
    stdin.write("\r");
    await delay();
    stdin.write("\x02");
    await delay();
    expect(convertCalls).toBe(1);
    expect(lastFrame()!).not.toContain("转为后台");
  });

  it("Ctrl+B:不在 busy 状态时(没有回合在跑)不触发", async () => {
    let convertCalls = 0;
    const { stdin } = render(
      <App {...makeDeps({ convertForegroundToBackground: () => { convertCalls++; return 1; } })} />,
    );
    stdin.write("\x02"); // 还没提交任何回合,busy=false
    await delay();
    expect(convertCalls).toBe(0);
  });

  it("ESC 中断当前回合后回填输入框;紧接着按 ↓ 直接清空,不用逐字删除", async () => {
    let resolveGate!: () => void;
    const { lastFrame, stdin } = render(
      <App
        {...makeDeps({
          submit: async () => new Promise<void>((r) => { resolveGate = r; }),
        })}
      />,
    );
    // 输入框那一行(边框内带 › / ⏎ 提示符);提交后的文本会永久留在 transcript 里也含 "hello",
    // 不能直接对整帧断言,只找带边框字符「│」的那一行,才能分清"回填在输入框里"还是"只是 transcript 历史"。
    const inputLine = (frame: string) => frame.split("\n").reverse().find((l) => l.includes("│") && /[›⏎]/.test(l)) ?? "";

    for (const ch of "hello") stdin.write(ch);
    await delay();
    stdin.write("\r"); // 提交,进入 busy
    await delay();
    stdin.write("\x1b"); // ESC 中断(无排队,直接中断)
    await delay();
    resolveGate(); // 放行(即使已 abort,mock 的 promise 需要有人 resolve 才会退出等待)
    await delay();
    expect(inputLine(lastFrame()!)).toContain("hello"); // 回填

    stdin.write("\x1b[B"); // ↓
    await delay();
    expect(inputLine(lastFrame()!)).not.toContain("hello"); // 一步清空,不用逐字删除
  });

  it("长任务模式 → 状态栏显示标识", () => {
    setLang("zh");
    const { lastFrame } = render(
      <App
        {...makeDeps({
          getStatus: () => ({ model: "m", mode: "normal", promptTokens: 0, completionTokens: 0, cacheHitRatio: 0, yolo: true, longTask: true, contextPct: 0 }),
        })}
      />,
    );
    expect(lastFrame()).toContain("长任务");
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
          submit: async (t: string | ContentPart[], { events }) => { submitted.push(typeof t === "string" ? t : "[img]"); events.assistantDone({ role: "assistant", content: "已处理" }); },
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
    // 出错 notice 是异步的(submit 抛错→catch→setState→render 比单个 delay 慢,CI 慢机尤甚)→ 轮询等待,消除 timing flake。
    for (let i = 0; i < 50 && !lastFrame()!.includes("出错:boom"); i++) await delay(20);
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

  it("i18n:状态栏标签跟随 locale(en 英文 / zh 中文)", () => {
    setLang("en");
    const en = render(<App {...makeDeps()} />).lastFrame()!;
    expect(en).toContain("Cache hit 50%");
    expect(en).toContain("Input");
    expect(en).toContain("Context");
    expect(en).not.toContain("缓存命中");
    setLang("zh");
    const zh = render(<App {...makeDeps()} />).lastFrame()!;
    expect(zh).toContain("缓存命中 50%");
    expect(zh).toContain("输入");
  });

  it("i18n:长任务标识跟随 locale(en)", () => {
    setLang("en");
    const f = render(
      <App {...makeDeps({
        getStatus: () => ({ model: "m", mode: "normal", promptTokens: 0, completionTokens: 0, cacheHitRatio: 0, yolo: false, longTask: true, contextPct: 0 }),
      })} />,
    ).lastFrame()!;
    expect(f).toContain("Long task");
    expect(f).not.toContain("长任务");
  });

  it("i18n:账户添加引导跟随 locale(en)", async () => {
    setLang("en");
    const { lastFrame, stdin } = render(
      <App {...makeDeps({ listAccounts: () => [], addAccount: async () => ({ ok: true, name: "default" }) })} />,
    );
    for (const ch of "/account") stdin.write(ch);
    await delay();
    stdin.write("\r");
    await delay();
    expect(lastFrame()!).toContain("Which provider");
    stdin.write("\r"); // 回车默认 deepseek
    await delay();
    const f = lastFrame()!;
    expect(f).toContain("Paste the DeepSeek official key");
    expect(f).not.toContain("粘贴");
  });

  it("i18n:主题切换通知跟随 locale(en)", async () => {
    setLang("en");
    const { lastFrame, stdin } = render(<App {...makeDeps()} />);
    for (const ch of "/theme") stdin.write(ch);
    await delay();
    stdin.write("\r");
    await delay();
    const f = lastFrame()!;
    expect(f).toContain("Theme switched");
    expect(f).not.toContain("已切换主题");
  });

  it("i18n:权限模式提示 + 模式标签跟随 locale(Shift+Tab)", async () => {
    setLang("en");
    const { lastFrame, stdin } = render(
      <App {...makeDeps({ cycleMode: () => "acceptEdits" })} />,
    );
    await delay();
    stdin.write("\x1b[Z"); // Shift+Tab(backtab)→ 循环权限模式
    await delay();
    const f = lastFrame()!;
    expect(f).toContain("permission mode →");
    expect(f).toContain("Auto-accept edits");
    expect(f).not.toContain("权限模式");
  });

  it("粘贴内容用裸 \\r 换行(部分终端的粘贴行为)→ 行数识别正确、归一化成 \\n 后完整送进上下文", async () => {
    // bracketed paste 时部分终端把行内的换行送成裸 \r(不是 \r\n),之前只处理 \r\n → \n,
    // 裸 \r 完全没识别,导致 split("\n") 永远只有 1 段——用户感知就是"粘贴总是识别成一行"。
    const submitted: (string | ContentPart[])[] = [];
    const { lastFrame, stdin } = render(
      <App {...makeDeps({ submit: async (t) => { submitted.push(t); } })} />,
    );
    const pasted = "line1\rline2\rline3\rline4\rline5\rline6\rline7"; // 7 行,裸 \r 分隔,超过 6 行折叠阈值
    stdin.write(`\x1b[200~${pasted}\x1b[201~`); // 真实 bracketed paste 转义序列,不走 useInput
    await delay();
    expect(lastFrame()!).toContain("[粘贴#1 +7行]"); // 行数识别对了,不是 1
    stdin.write("\r"); // 提交
    await delay();
    expect(submitted).toEqual([pasted.replace(/\r/g, "\n")]); // 完整 7 行都送进了上下文,换行归一成 \n
  });

  it("提交内容是绝对路径(以 / 开头但不是命令)→ 当普通文本发送,不会被误判成斜杠命令报'未知命令'", async () => {
    // 真实场景:把图片文件拖进终端窗口,很多终端会把它转成插入这个文件的绝对路径这种纯文本粘贴。
    // 这里模拟"路径对应的文件其实不存在/不是图片"这种兜底分支(paste 阶段的图片探测会读文件失败,
    // 退回当文本插入),验证的是"提交阶段"的斜杠命令判断不会把这种路径误当命令。
    let submitted: string | ContentPart[] | undefined;
    let ranCommand = "";
    const { stdin } = render(
      <App {...makeDeps({
        submit: async (t, { events }) => { submitted = t; events.assistantDone({ role: "assistant", content: "ok" }); },
        runCommand: (line) => { ranCommand = line; return { handled: true, output: "未知命令" }; },
      })} />,
    );
    const fakePath = "/Users/x/Desktop/IMG_3178.jpeg"; // 这台测试机上不存在,paste 阶段图片探测会失败退回文本
    stdin.write(`\x1b[200~${fakePath}\x1b[201~`);
    await delay();
    stdin.write("\r");
    await delay();
    expect(ranCommand).toBe(""); // 没有走命令分发
    expect(submitted).toBe(fakePath); // 原样当文本发给了模型
  });

  it("粘贴/拖入一个真实存在的图片文件路径 → 自动识别成图片附件,不是纯文本路径字符串", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dao-app-test-"));
    const imgPath = path.join(dir, "shot.png");
    writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])); // PNG magic bytes
    let submitted: string | ContentPart[] | undefined;
    const { lastFrame, stdin } = render(
      <App {...makeDeps({
        submit: async (t, { events }) => { submitted = t; events.assistantDone({ role: "assistant", content: "ok" }); },
        getStatus: () => ({ model: "kimi-k2.6", mode: "normal", promptTokens: 12, completionTokens: 3, cacheHitRatio: 0.5, yolo: false, branch: "main", contextPct: 0.3 }), // 支持图片输入的模型
      })} />,
    );
    stdin.write(`\x1b[200~${imgPath}\x1b[201~`);
    await delay(80); // 图片探测是异步的(读文件),多等一下
    expect(lastFrame()!).toContain("[图片#1]"); // 输入框里是图片占位符,不是原始路径字符串
    stdin.write("\r");
    await delay();
    expect(Array.isArray(submitted)).toBe(true);
    const parts = submitted as ContentPart[];
    expect(parts.some((p) => p.type === "image_url" && p.image_url.url.startsWith("data:image/png;base64,"))).toBe(true);
  });
});
