import type { Capabilities } from "./capabilities.js";

export type Semantic = "ink" | "jade" | "vermilion" | "dim" | "gold";

type RGB = [number, number, number];
interface ColorSpec { rgb: RGB; ansi256: number; ansi16: string } // ansi16:SGR 数字串如 "36"

// 一套精调默认主题(墨黑底假设):青玉强调 + 朱砂印 + 暖金点缀。
const PALETTE: Record<Semantic, ColorSpec> = {
  ink:       { rgb: [220, 223, 228], ansi256: 252, ansi16: "37" },
  jade:      { rgb: [127, 183, 166], ansi256: 79,  ansi16: "36" },
  vermilion: { rgb: [200, 68, 60],   ansi256: 167, ansi16: "31" },
  dim:       { rgb: [128, 132, 140], ansi256: 245, ansi16: "90" },
  gold:      { rgb: [201, 168, 106], ansi256: 179, ansi16: "33" },
};

const FG_RESET = "\x1b[39m";

function fg(rgb: RGB): string {
  return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

// 用语义色包裹一段文本(单行)。none 档返回原文。
export function paint(text: string, sem: Semantic, caps: Capabilities): string {
  const c = PALETTE[sem];
  switch (caps.tier) {
    case "none": return text;
    case "truecolor": return `${fg(c.rgb)}${text}${FG_RESET}`;
    case "ansi256": return `\x1b[38;5;${c.ansi256}m${text}${FG_RESET}`;
    case "ansi16": return `\x1b[${c.ansi16}m${text}${FG_RESET}`;
  }
}

// 线性插值两 RGB。
function lerp(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

// 对多行块做 from→to 的横向真彩渐变(按列位置插值,逐行一致)。
// 非 truecolor 退化:整体用 from 语义单色(paint 每行);none 原样。
export function gradientBlock(lines: string[], from: Semantic, to: Semantic, caps: Capabilities): string[] {
  if (caps.tier === "none") return [...lines];
  if (caps.tier !== "truecolor") return lines.map((l) => paint(l, from, caps));
  const a = PALETTE[from].rgb;
  const b = PALETTE[to].rgb;
  const maxLen = Math.max(1, ...lines.map((l) => [...l].length));
  return lines.map((line) => {
    const chars = [...line];
    let out = "";
    chars.forEach((ch, i) => {
      const t = chars.length > 1 ? i / (maxLen - 1 || 1) : 0;
      out += `${fg(lerp(a, b, Math.min(1, t)))}${ch}`;
    });
    return out + FG_RESET;
  });
}
