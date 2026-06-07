// scripts/preview-welcome.ts
// 独立预览欢迎横幅,供真终端目视调优。
//   npm run preview:welcome                        # 真实终端能力 + 自动检测亮/暗背景(OSC 11)
//   npm run preview:welcome -- --tier truecolor    # 强制色档(truecolor/ansi256/ansi16/none)
//   npm run preview:welcome -- --bg light          # 强制背景(light/dark)
import { detectCapabilities, type ColorTier } from "../src/tui/capabilities.js";
import { buildWelcome } from "../src/tui/banner.js";
import { resolveBackground, bgFromEnv, type Background } from "../src/tui/background.js";

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const forced = flag("--tier") as ColorTier | undefined;
const forcedBg = flag("--bg") as Background | undefined;

const bg = forcedBg ?? bgFromEnv(process.env) ?? (await resolveBackground(process.env));

const real = detectCapabilities(process.env, !!process.stdout.isTTY, process.stdout.columns);
const caps = forced ? { ...real, tier: forced } : real;

process.stdout.write(
  buildWelcome(
    {
      model: "deepseek-v4-pro",
      thinking: "max",
      cwd: process.cwd(),
      version: "0.1.0",
      branch: "dao-code-p1",
    },
    caps,
    undefined,
    bg,
  ) + "\n",
);
