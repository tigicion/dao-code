import type { Capabilities } from "./capabilities.js";
import type { Background } from "./background.js";

// 程序化像素风太极(阴阳鱼)—— 纯背景色渲染,零字形依赖。
//
// 关键决策:Apple Terminal 等终端里,块字形(▀▄█ 及象限块)按字体字形绘制,
// 字形与字符格边缘之间可能有缝(行距/覆盖不准)——白缝/漏色/突刺皆源于此。
// 唯一像素级精确的原语是"背景色整格涂"(按格子矩形涂,与字体无关)。
// 因此:像素一律用"空格 + 背景色"画,整幅图只由纯色矩形构成——
// 突刺/漏色/白缝在构造上不可能出现。
//
// 尺寸:8 行高(与右侧 DAO CODE 词标块齐平)× 16 列;
// 横向用 1 列细像素(16×8 像素网格,横向分辨率不因高度减半而损失)。
//
// 形状质量:
// - 逐行解析光栅化:圆的弦宽、S 线分界点逐行用公式精确求出,每行 yang→yin
//   只有一次转折,台阶渐进单调;
// - classify 对 180° 旋转严格反对称 → 两条鱼的台阶逐像素一致。

type RGB = [number, number, number];

interface Palette { yang: RGB; yin: RGB }
const PALETTES: Record<Background, Palette> = {
  dark: { yang: [236, 238, 242], yin: [64, 116, 106] },
  light: { yang: [54, 62, 74], yin: [104, 162, 146] },
};

const ROWS = 8; // 行数 = 纵向像素数(与词标块同高)
const COLS = 16; // 列数 = 横向像素数(每像素 1 列,宽 0.5 行高单位)
const R = ROWS / 2; // 圆半径(单位 = 行高)

type Cls = "out" | "yang" | "yin";

// 单像素分类:中心点解析判定(圆按半径,S 线按每行唯一分界点,眼按菱形)。
function pixel(px: number, py: number): Cls {
  const x = (px + 0.5) * 0.5 - R; // 横向像素宽 0.5 单位
  const y = R - (py + 0.5);
  if (x * x + y * y > R * R) return "out";
  const half = R / 2;
  const re = 0.6; // 菱形眼"半径";眼心对齐行中心(half+0.5)→ 恰为 2 列×1 行的方点
  if (Math.abs(x) + Math.abs(y - (half + 0.5)) <= re) return "yin"; // 阳鱼中的阴眼
  if (Math.abs(x) + Math.abs(y + (half + 0.5)) <= re) return "yang"; // 阴鱼中的阳眼
  // S 线:该行 yang/yin 的唯一分界点(上半=上鱼头右缘,下半=下鱼头左缘)。
  const xb =
    y >= 0
      ? Math.sqrt(Math.max(0, half * half - (y - half) * (y - half)))
      : -Math.sqrt(Math.max(0, half * half - (y + half) * (y + half)));
  return x < xb ? "yang" : "yin";
}

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
  const pal = PALETTES[bg];
  const truecolor = caps.tier === "truecolor";
  const bgc = (c: Exclude<Cls, "out">) =>
    truecolor
      ? `\x1b[48;2;${pal[c][0]};${pal[c][1]};${pal[c][2]}m`
      : `\x1b[48;5;${c === "yang" ? 254 : 65}m`;

  const out: string[] = [];
  for (let py = 0; py < ROWS; py++) {
    let line = "";
    let cur: Cls | "" = ""; // 当前已生效的背景色(同色连续像素不重复发转义)
    for (let px = 0; px < COLS; px++) {
      const c = pixel(px, py);
      if (c === "out") {
        if (cur !== "out") { line += "\x1b[0m"; cur = "out"; }
      } else if (cur !== c) { line += bgc(c); cur = c; }
      line += " ";
    }
    out.push(line + "\x1b[0m");
  }
  return out;
}

export const TAIJI_WIDTH = (caps: Capabilities): number =>
  caps.tier === "none" || caps.tier === "ansi16"
    ? Math.max(...FALLBACK.map((l) => [...l].length))
    : COLS;
