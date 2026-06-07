import type { Capabilities } from "./capabilities.js";
import type { Background } from "./background.js";

// 程序化生成太极(阴阳鱼),带(锐化的)抗锯齿。
// 技法:每个字符用上半块 "▀" —— 前景=上像素、背景=下像素,把垂直分辨率翻倍。
// 抗锯齿:每像素 SS×SS 超采样;覆盖率经 smoothstep 锐化(留薄薄一圈过渡、不糊),
// 边缘向背景混色、阴阳按占比混色。truecolor 全抗锯齿;ansi256 两色硬边;ansi16/none 退化简图。

type RGB = [number, number, number];

// 每种背景一组配色:阳鱼、阴鱼、用于边缘抗锯齿的"背景混合色"。鱼眼由公式对色,自然得到。
interface Palette { yang: RGB; yin: RGB; bgBlend: RGB }
const PALETTES: Record<Background, Palette> = {
  dark: { yang: [236, 238, 242], yin: [70, 122, 112], bgBlend: [20, 20, 22] },
  light: { yang: [60, 68, 80], yin: [104, 160, 146], bgBlend: [252, 252, 250] },
};

const DIAM = 22; // 像素直径(偶数)→ 22 列、11 字符行
const R = DIAM / 2;
const SS = 4; // 超采样密度

type Sample = { coverage: number; yang: number };

// 连续坐标分类:点是否在圆内,以及属阳(true)还是阴。
function classify(x: number, y: number): { inside: boolean; yang: boolean } {
  const inside = x * x + y * y <= R * R;
  if (!inside) return { inside: false, yang: false };
  const half = R / 2;
  const eyeR2 = (R / 6) * (R / 6);
  const dUp = x * x + (y - half) * (y - half);
  const dLo = x * x + (y + half) * (y + half);
  let yang: boolean;
  if (dUp <= eyeR2) yang = false; // 阳鱼中的阴眼
  else if (dLo <= eyeR2) yang = true; // 阴鱼中的阳眼
  else if (dUp <= half * half) yang = true; // 上鱼头:阳
  else if (dLo <= half * half) yang = false; // 下鱼头:阴
  else yang = x < 0; // 左阳右阴
  return { inside: true, yang };
}

function sample(px: number, py: number, cx: number, cy: number): Sample {
  let inN = 0;
  let yangN = 0;
  for (let i = 0; i < SS; i++) {
    for (let j = 0; j < SS; j++) {
      const sx = px + (i + 0.5) / SS - 0.5 - cx;
      const sy = cy - (py + (j + 0.5) / SS - 0.5);
      const c = classify(sx, sy);
      if (c.inside) {
        inN++;
        if (c.yang) yangN++;
      }
    }
  }
  const tot = SS * SS;
  return { coverage: inN / tot, yang: inN ? yangN / inN : 0 };
}

const blend = (a: RGB, b: RGB, t: number): RGB => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

// smoothstep:把覆盖率向 0/1 推,锐化圆周(留薄过渡圈,不糊)。
function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function pixelRGB(s: Sample, pal: Palette): RGB {
  const fish = blend(pal.yin, pal.yang, s.yang);
  return blend(pal.bgBlend, fish, smoothstep(0.2, 0.8, s.coverage));
}

const tcFg = (c: RGB) => `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
const tcBg = (c: RGB) => `\x1b[48;2;${c[0]};${c[1]};${c[2]}m`;

// 简图退化(none/ansi16):无半块、无背景色依赖。
const FALLBACK = [
  "    .-‐‐-.",
  "  /   ·   \\",
  " |   (·)   |",
  " |   (·)   |",
  "  \\   ·   /",
  "    `-‐‐-'",
];

const EPS = 0.1; // 覆盖率低于此视为圆外

export function renderTaiji(caps: Capabilities, bg: Background = "dark"): string[] {
  if (caps.tier === "none" || caps.tier === "ansi16") return [...FALLBACK];

  const cols = DIAM;
  const rows = DIAM / 2;
  const cx = (DIAM - 1) / 2;
  const cy = (DIAM - 1) / 2;
  const pal = PALETTES[bg];
  const truecolor = caps.tier === "truecolor";

  // ansi256:两色硬边(覆盖>0.5、阳占比定色),不混色。
  const hard256 = (s: Sample): string | null =>
    s.coverage < 0.5 ? null : `\x1b[38;5;${s.yang >= 0.5 ? 254 : 65}m`;

  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let c = 0; c < cols; c++) {
      const top = sample(c, r * 2, cx, cy);
      const bot = sample(c, r * 2 + 1, cx, cy);
      const tOn = top.coverage >= EPS;
      const bOn = bot.coverage >= EPS;
      if (!tOn && !bOn) {
        line += "\x1b[0m ";
        continue;
      }
      if (truecolor) {
        if (tOn && bOn) line += `${tcFg(pixelRGB(top, pal))}${tcBg(pixelRGB(bot, pal))}▀`;
        else if (tOn) line += `\x1b[49m${tcFg(pixelRGB(top, pal))}▀`;
        else line += `\x1b[49m${tcFg(pixelRGB(bot, pal))}▄`;
      } else {
        const tc = hard256(top);
        const bc = hard256(bot);
        if (tc && bc) line += `${tc}${bc.replace("[38", "[48")}▀`;
        else if (tc) line += `\x1b[49m${tc}▀`;
        else if (bc) line += `\x1b[49m${bc}▄`;
        else line += "\x1b[0m ";
      }
    }
    lines.push(line + "\x1b[0m");
  }
  return lines;
}

export const TAIJI_WIDTH = (caps: Capabilities): number =>
  caps.tier === "none" || caps.tier === "ansi16"
    ? Math.max(...FALLBACK.map((l) => [...l].length))
    : DIAM;
