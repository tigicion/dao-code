// scripts/preview-welcome.ts
// 独立预览欢迎横幅,供真终端目视调优。
//   npm run preview:welcome             # 用真实终端能力
//   npm run preview:welcome -- --tier truecolor   # 强制档位(truecolor/ansi256/ansi16/none)
import { detectCapabilities, type ColorTier } from "../src/tui/capabilities.js";
import { buildWelcome } from "../src/tui/banner.js";

const arg = process.argv.indexOf("--tier");
const forced = arg >= 0 ? (process.argv[arg + 1] as ColorTier) : undefined;

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
  ) + "\n",
);
