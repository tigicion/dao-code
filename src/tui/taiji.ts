import type { Capabilities } from "./capabilities.js";
import type { Background } from "./background.js";

// 程序化生成太极(阴阳鱼)—— 硬边、纯色、清晰。
// 圆周与阴阳 S 线:超采样多数表决判像素(更圆),颜色实心(不混色,不模糊)。
// 鱼眼:不再用公式画(会糊成一团),而是在两个鱼头中心"盖"一个精确的单格实心点(参考 CC 手绘块元素的可控性)。
// 技法:每个字符用上半块 "▀" —— 前景=上像素、背景=下像素,垂直分辨率翻倍。
// truecolor/ansi256 双色阴阳鱼;ansi16/none 退化简图。

type RGB = [number, number, number];

interface Palette { yang: RGB; yin: RGB }
const PALETTES: Record<Background, Palette> = {
  dark: { yang: [236, 238, 242], yin: [64, 116, 106] },
  light: { yang: [54, 62, 74], yin: [104, 162, 146] },
};

const DIAM = 20; // 像素直径(偶数)→ 20 列、10 字符行
const R = DIAM / 2;
const SS = 3;

type Cell = "out" | "yang" | "yin";

// 圆 + 左阳右阴 + 上下鱼头(不含鱼眼)。
function classify(x: number, y: number): Cell {
  if (x * x + y * y > R * R) return "out";
  const half = R / 2;
  const dUp = x * x + (y - half) * (y - half);
  const dLo = x * x + (y + half) * (y + half);
  if (dUp <= half * half) return "yang"; // 上鱼头:阳
  if (dLo <= half * half) return "yin"; // 下鱼头:阴
  return x < 0 ? "yang" : "yin"; // 左阳右阴
}

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
  if (inN * 2 < SS * SS) return "out";
  return yangN * 2 >= inN ? "yang" : "yin";
}

const tcFg = (c: RGB) => `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
const tcBg = (c: RGB) => `\x1b[48;2;${c[0]};${c[1]};${c[2]}m`;
const c256 = (cell: "yang" | "yin") => (cell === "yang" ? 254 : 65);

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

  // 先建 cell 网格(每格上/下两像素)。
  const grid: { top: Cell; bot: Cell }[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: { top: Cell; bot: Cell }[] = [];
    for (let c = 0; c < cols; c++) {
      row.push({ top: votePixel(c, r * 2, cx, cy), bot: votePixel(c, r * 2 + 1, cx, cy) });
    }
    grid.push(row);
  }

  // 盖鱼眼:单格实心点。上鱼头(阳)里盖阴眼,下鱼头(阴)里盖阳眼。
  const eyeCol = Math.round(cx); // 中心列
  const upRow = Math.round((cy - R / 2) / 2); // 上鱼头中心所在字符行
  const loRow = Math.round((cy + R / 2) / 2); // 下鱼头中心所在字符行
  const stamp = (r: number, c: number, v: "yang" | "yin") => {
    if (grid[r]?.[c]) grid[r]![c] = { top: v, bot: v };
  };
  stamp(upRow, eyeCol, "yin"); // 阳鱼中的阴眼
  stamp(loRow, eyeCol, "yang"); // 阴鱼中的阳眼

  const fg = (cell: Cell) =>
    cell === "out" ? "" : truecolor ? tcFg(cell === "yang" ? pal.yang : pal.yin) : `\x1b[38;5;${c256(cell)}m`;
  const bgc = (cell: Cell) =>
    cell === "out" ? "" : truecolor ? tcBg(cell === "yang" ? pal.yang : pal.yin) : `\x1b[48;5;${c256(cell)}m`;

  return grid.map((row) => {
    let line = "";
    for (const { top, bot } of row) {
      if (top === "out" && bot === "out") line += "\x1b[0m ";
      else if (top !== "out" && bot !== "out") line += `${fg(top)}${bgc(bot)}▀`;
      else if (top !== "out") line += `\x1b[49m${fg(top)}▀`;
      else line += `\x1b[49m${fg(bot)}▄`;
    }
    return line + "\x1b[0m";
  });
}

export const TAIJI_WIDTH = (caps: Capabilities): number =>
  caps.tier === "none" || caps.tier === "ansi16"
    ? Math.max(...FALLBACK.map((l) => [...l].length))
    : DIAM;
