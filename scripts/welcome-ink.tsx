// scripts/welcome-ink.tsx
// Ink 版欢迎屏预览(整宽边框 + 两栏 + 随终端 resize 重排)。
//   npm run preview:ink                 # 真终端:常驻,试着拖动窗口大小看自适应;Ctrl-C 退出
//   npm run preview:ink -- --bg light   # 强制背景(light/dark)
//   npm run preview:ink -- --tier ansi256
import React from "react";
import { render, useApp, useInput } from "ink";
import { Welcome } from "../src/tui/Welcome.js";
import { detectCapabilities, type ColorTier } from "../src/tui/capabilities.js";
import { bgFromEnv, type Background } from "../src/tui/background.js";
import { randomMaxim } from "../src/tui/maxim.js";

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const forcedTier = flag("--tier") as ColorTier | undefined;
const forcedBg = flag("--bg") as Background | undefined;

// 不在 render 前做 OSC 探测(会和 Ink 抢 stdin 致闪退)。用 --bg / DAO_THEME / COLORFGBG / 默认。
const bg: Background = forcedBg ?? bgFromEnv(process.env) ?? "dark";
const real = detectCapabilities(process.env, !!process.stdout.isTTY, process.stdout.columns);
const caps = forcedTier ? { ...real, tier: forcedTier } : real;

// interactive=isTTY 绕过 Ink 对 CI 的误判(否则不挂键盘→无 keep-alive→闪退)。inline 模式,与真实 app 一致。
const renderOpts = { interactive: !!process.stdout.isTTY } as unknown as Parameters<typeof render>[1];

const maxim = randomMaxim();

// 预览包一层:useInput 让 stdin 进入 flowing 态(keep-alive,否则事件循环空了进程会直接退出)
// 并处理 q / Ctrl-C 退出。真实 app 里由 REPL 输入循环 keep-alive,不需要这层。
function Preview() {
  const { exit } = useApp();
  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c") || key.escape) exit();
  });
  return (
    <Welcome
      info={{
        model: "deepseek-v4-pro",
        thinking: "max",
        cwd: process.cwd(),
        version: "0.1.0",
        branch: "dao-code-p1",
      }}
      caps={caps}
      bg={bg}
      maxim={maxim}
    />
  );
}

const app = render(<Preview />, renderOpts);

// 管道/非 TTY:渲染一帧后退出(便于脚本核对);真终端则常驻直到 q / Ctrl-C / Esc。
if (!process.stdout.isTTY) setTimeout(() => app.unmount(), 120);
await app.waitUntilExit();
