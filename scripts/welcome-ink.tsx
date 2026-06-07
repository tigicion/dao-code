// scripts/welcome-ink.tsx
// Ink 版欢迎屏预览(整宽边框 + 两栏 + 随终端 resize 重排)。
//   npm run preview:ink                 # 真终端:常驻,试着拖动窗口大小看自适应;Ctrl-C 退出
//   npm run preview:ink -- --bg light   # 强制背景(light/dark)
//   npm run preview:ink -- --tier ansi256
import React from "react";
import { render } from "ink";
import { Welcome } from "../src/tui/Welcome.js";
import { detectCapabilities, type ColorTier } from "../src/tui/capabilities.js";
import { resolveBackground, bgFromEnv, type Background } from "../src/tui/background.js";
import { randomMaxim } from "../src/tui/maxim.js";

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const forcedTier = flag("--tier") as ColorTier | undefined;
const forcedBg = flag("--bg") as Background | undefined;

const bg: Background = forcedBg ?? bgFromEnv(process.env) ?? (await resolveBackground(process.env));
const real = detectCapabilities(process.env, !!process.stdout.isTTY, process.stdout.columns);
const caps = forcedTier ? { ...real, tier: forcedTier } : real;

const app = render(
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
    maxim={randomMaxim()}
  />,
);

// 管道/非 TTY:渲染一帧后退出(便于脚本核对);真终端则常驻直到 Ctrl-C。
if (!process.stdout.isTTY) setTimeout(() => app.unmount(), 120);
await app.waitUntilExit();
