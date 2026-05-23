export type ColorTier = "truecolor" | "ansi256" | "ansi16" | "none";

export interface Capabilities {
  tier: ColorTier;
  isTTY: boolean;
  columns: number;
}

// 探测终端颜色能力。优先级:非TTY/NO_COLOR → none;FORCE_COLOR/COLORTERM → truecolor;
// TERM 含 256color → ansi256;否则 TTY → ansi16。columns:显式参数 > COLUMNS > 80。
export function detectCapabilities(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  isTTY: boolean,
  columns?: number,
): Capabilities {
  // 用 || 链:显式列数 > COLUMNS > 80;0/NaN/undefined 都回退(终端偶尔报 columns=0)。
  const cols = columns || (env.COLUMNS ? parseInt(env.COLUMNS, 10) : 0) || 80;
  if (!isTTY || env.NO_COLOR) return { tier: "none", isTTY, columns: cols };

  const force = env.FORCE_COLOR;
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  const term = (env.TERM ?? "").toLowerCase();

  let tier: ColorTier;
  if (force === "3" || /truecolor|24bit/.test(colorterm)) tier = "truecolor";
  else if (force === "2" || term.includes("256color")) tier = "ansi256";
  else tier = "ansi16";

  return { tier, isTTY, columns: cols };
}
