// scripts/preview-welcome.ts
// 独立预览欢迎横幅,供真终端目视调优。
//   npm run preview:welcome             # 用真实终端能力
//   npm run preview:welcome -- --tier truecolor   # 强制档位(truecolor/ansi256/ansi16/none)
import { detectCapabilities, type ColorTier } from "../src/tui/capabilities.js";
import { buildWelcome } from "../src/tui/banner.js";
import { detectBackground, type Background } from "../src/tui/taiji.js";

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const forced = flag("--tier") as ColorTier | undefined;
const bg = (flag("--bg") as Background | undefined) ?? detectBackground(process.env);

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
