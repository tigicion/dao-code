import type { Capabilities } from "./capabilities.js";

// 程序化生成太极(阴阳鱼)。
// 技法:每个终端字符用上半块 "▀" —— 前景色画"上像素"、背景色画"下像素",
// 把垂直分辨率翻倍(一行字符 = 两行像素),从而画出圆与 S 曲线。
// truecolor/ansi256 走两色阴阳鱼;ansi16/none 退化为简图。

type RGB = [number, number, number];

// 阳(浅,暖墨)/ 阴(深,带一点青玉)。在墨黑底上都可见。
const YANG: RGB = [230, 232, 236];
const YIN: RGB = [58, 92, 86];

// 直径(像素)。需为偶数以便半块成对。15 列、16 像素高 → 8 字符行,近似正圆。
const DIAM = 16;
const R = DIAM / 2; // 8

// 某像素(以圆心为原点,y 向上)属于:外部 / 阳 / 阴。
type Cell = "out" | "yang" | "yin";
function pixel(x: number, y: number): Cell {
  if (x * x + y * y > R * R) return "out";
  const half = R / 2;
  const eyeR2 = (R / 5) * (R / 5);
  const dUp = x * x + (y - half) * (y - half); // 上半圆(圆心 0,+R/2)
  const dLo = x * x + (y + half) * (y + half); // 下半圆(圆心 0,-R/2)
  if (dUp <= eyeR2) return "yin"; // 阳鱼中的阴眼
  if (dLo <= eyeR2) return "yang"; // 阴鱼中的阳眼
  if (dUp <= half * half) return "yang"; // 上鱼头:阳
  if (dLo <= half * half) return "yin"; // 下鱼头:阴
  return x < 0 ? "yang" : "yin"; // 左阳右阴
}

const tcFg = (c: RGB) => `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
const tcBg = (c: RGB) => `\x1b[48;2;${c[0]};${c[1]};${c[2]}m`;
// ansi256 近似:阳=254(近白)、阴=238(深灰)。
const c256 = (cell: "yang" | "yin") => (cell === "yang" ? 254 : 238);

// 简图退化(none/ansi16):无半块、无背景色依赖。
const FALLBACK = [
  "   .-‐‐-.",
  "  / ·   \\",
  " |  (·)  |",
  " |  (·)  |",
  "  \\   · /",
  "   `-‐‐-'",
];

export function renderTaiji(caps: Capabilities): string[] {
  if (caps.tier === "none" || caps.tier === "ansi16") return [...FALLBACK];

  const cols = DIAM - 1; // 15 列
  const rows = DIAM / 2; // 8 行
  const cx = (cols - 1) / 2;
  const cyTop = (rows * 2 - 1) / 2; // 像素纵向中心

  const truecolor = caps.tier === "truecolor";
  const fg = (cell: Cell) =>
    cell === "out" ? "" : truecolor ? tcFg(cell === "yang" ? YANG : YIN) : `\x1b[38;5;${c256(cell)}m`;
  const bg = (cell: Cell) =>
    cell === "out" ? "" : truecolor ? tcBg(cell === "yang" ? YANG : YIN) : `\x1b[48;5;${c256(cell)}m`;

  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let c = 0; c < cols; c++) {
      const x = c - cx;
      const top = pixel(x, cyTop - r * 2); // 上像素
      const bot = pixel(x, cyTop - (r * 2 + 1)); // 下像素
      if (top === "out" && bot === "out") {
        line += "\x1b[0m ";
      } else if (top !== "out" && bot !== "out") {
        line += `${fg(top)}${bg(bot)}▀`; // 上=前景、下=背景
      } else if (top !== "out") {
        line += `\x1b[49m${fg(top)}▀`; // 仅上像素:背景透明
      } else {
        line += `\x1b[49m${fg(bot)}▄`; // 仅下像素
      }
    }
    lines.push(line + "\x1b[0m");
  }
  return lines;
}

// 渲染时的"可见宽度"(去 ANSI 后的列数),供居中用。
export const TAIJI_WIDTH = (caps: Capabilities): number =>
  caps.tier === "none" || caps.tier === "ansi16"
    ? Math.max(...FALLBACK.map((l) => [...l].length))
    : DIAM - 1;
