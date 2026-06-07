import type { Capabilities } from "./capabilities.js";
import type { Background } from "./background.js";

// 程序化生成太极(阴阳鱼)—— 硬边、纯色、清晰(不抗锯齿,避免模糊)。
// 技法:每个字符用上半块 "▀" —— 前景=上像素、背景=下像素,把垂直分辨率翻倍。
// 每像素 SS×SS 超采样做"多数表决"判 外/阳/阴(让圆周判定更圆),颜色一律实心。
// truecolor/ansi256 渲两色阴阳鱼;ansi16/none 退化简图。

type RGB = [number, number, number];

// 每种背景一组实心配色:阳鱼、阴鱼。鱼眼由公式对色,自然得到。
interface Palette { yang: RGB; yin: RGB }
const PALETTES: Record<Background, Palette> = {
  dark: { yang: [236, 238, 242], yin: [64, 116, 106] },
  light: { yang: [54, 62, 74], yin: [104, 162, 146] },
};

const DIAM = 20; // 像素直径(偶数)→ 20 列、10 字符行
const R = DIAM / 2;
const SS = 3; // 超采样密度(仅用于更圆的判定,不做混色)

type Cell = "out" | "yang" | "yin";

// 连续坐标分类:点是否在圆内,以及属阳还是阴。
function classify(x: number, y: number): Cell {
  if (x * x + y * y > R * R) return "out";
  const half = R / 2;
  const eyeR2 = (R / 6) * (R / 6);
  const dUp = x * x + (y - half) * (y - half);
  const dLo = x * x + (y + half) * (y + half);
  if (dUp <= eyeR2) return "yin"; // 阳鱼中的阴眼
  if (dLo <= eyeR2) return "yang"; // 阴鱼中的阳眼
  if (dUp <= half * half) return "yang"; // 上鱼头:阳
  if (dLo <= half * half) return "yin"; // 下鱼头:阴
  return x < 0 ? "yang" : "yin"; // 左阳右阴
}

// 对单像素 SS×SS 超采样,多数表决:外占多 → out,否则取阳/阴多者(纯色,不混)。
function votePixel(px: number, py: number, cx: number, cy: number): Cell {
  let inN = 0;
  let yangN = 0;
  for (let i = 0; i < SS; i++) {
    for (let j = 0; j < SS; j++) {
      const c = classify(px + (i + 0.5) / SS - 0.5 - cx, cy - (py + (j + 0.5) / SS - 0.5));
      if (c !== "out") {
        inN++;
        if (c === "yang") yangN++;
      }
    }
  }
  const tot = SS * SS;
  if (inN * 2 < tot) return "out"; // 多数在圆外
  return yangN * 2 >= inN ? "yang" : "yin";
}

const tcFg = (c: RGB) => `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
const tcBg = (c: RGB) => `\x1b[48;2;${c[0]};${c[1]};${c[2]}m`;
const c256 = (cell: "yang" | "yin") => (cell === "yang" ? 254 : 65);

// 简图退化(none/ansi16):无半块、无背景色依赖。
const FALLBACK = [
  "    .-‐‐-.",
  "  /   ·   \\",
  " |   (·)   |",
  " |   (·)   |",
  "  \\   ·   /",
  "    `-‐‐-'",
];

export function renderTaiji(caps: Capabilities, bg: Background = "dark"): string[] {
  if (caps.tier === "none" || caps.tier === "ansi16") return [...FALLBACK];

  const cols = DIAM;
  const rows = DIAM / 2;
  const cx = (DIAM - 1) / 2;
  const cy = (DIAM - 1) / 2;
  const pal = PALETTES[bg];
  const truecolor = caps.tier === "truecolor";

  const fg = (cell: Cell) =>
    cell === "out" ? "" : truecolor ? tcFg(cell === "yang" ? pal.yang : pal.yin) : `\x1b[38;5;${c256(cell)}m`;
  const bgc = (cell: Cell) =>
    cell === "out" ? "" : truecolor ? tcBg(cell === "yang" ? pal.yang : pal.yin) : `\x1b[48;5;${c256(cell)}m`;

  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let c = 0; c < cols; c++) {
      const top = votePixel(c, r * 2, cx, cy);
      const bot = votePixel(c, r * 2 + 1, cx, cy);
      if (top === "out" && bot === "out") line += "\x1b[0m ";
      else if (top !== "out" && bot !== "out") line += `${fg(top)}${bgc(bot)}▀`;
      else if (top !== "out") line += `\x1b[49m${fg(top)}▀`;
      else line += `\x1b[49m${fg(bot)}▄`;
    }
    lines.push(line + "\x1b[0m");
  }
  return lines;
}

export const TAIJI_WIDTH = (caps: Capabilities): number =>
  caps.tier === "none" || caps.tier === "ansi16"
    ? Math.max(...FALLBACK.map((l) => [...l].length))
    : DIAM;
