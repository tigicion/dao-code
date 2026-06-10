// 太极图预览:终端直接跑 `npm run preview:taiji`,深/浅两版肉眼验收。
import { renderTaiji } from "../src/tui/taiji.js";
import type { Capabilities } from "../src/tui/capabilities.js";

const caps: Capabilities = { tier: "truecolor", isTTY: true, columns: process.stdout.columns || 100 };

for (const bg of ["light", "dark"] as const) {
  process.stdout.write(`\n${bg === "light" ? "浅色背景版(白底终端)" : "深色背景版(黑底终端)"}:\n\n`);
  for (const line of renderTaiji(caps, bg)) process.stdout.write("   " + line + "\n");
}
process.stdout.write("\n");
