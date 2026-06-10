import type { Capabilities } from "./capabilities.js";
import type { Background } from "./background.js";
import { paint, gradientBlock } from "./theme.js";
import { randomMaxim } from "./maxim.js";
import { renderTaiji, TAIJI_WIDTH } from "./taiji.js";
import { displayWidth } from "./width.js";

export interface WelcomeInfo {
  model: string;
  thinking: string;
  cwd: string;
  version: string;
  branch?: string;
}

// DAO CODE 词标(ANSI Shadow 风格)。
export const WORDMARK = [
  "██████╗  █████╗  ██████╗    ██████╗ ██████╗ ██████╗ ███████╗",
  "██╔══██╗██╔══██╗██╔═══██╗  ██╔════╝██╔═══██╗██╔══██╗██╔════╝",
  "██║  ██║███████║██║   ██║  ██║     ██║   ██║██║  ██║█████╗  ",
  "██║  ██║██╔══██║██║   ██║  ██║     ██║   ██║██║  ██║██╔══╝  ",
  "██████╔╝██║  ██║╚██████╔╝  ╚██████╗╚██████╔╝██████╔╝███████╗",
  "╚═════╝ ╚═╝  ╚═╝ ╚═════╝    ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝",
];

// 居中一行:按"可见宽度"(去 ANSI,用 displayWidth 处理 CJK)算缩进。
function centerColored(line: string, visibleLen: number, columns: number): string {
  const pad = Math.max(0, Math.floor((columns - visibleLen) / 2));
  return " ".repeat(pad) + line;
}

// 长路径缩短:超过 3 段时取末 3 段并加 …/ 前缀。
function shortenPath(p: string): string {
  const segs = p.split("/").filter(Boolean);
  return segs.length <= 3 ? p : "…/" + segs.slice(-3).join("/");
}

export function buildWelcome(
  info: WelcomeInfo,
  caps: Capabilities,
  rng?: () => number,
  bg: Background = "dark",
): string {
  const cols = caps.columns;
  const out: string[] = [];
  const blank = () => out.push("");
  const P = (t: string, sem: Parameters<typeof paint>[1]) => paint(t, sem, caps, bg);

  blank();
  // 太极(程序化阴阳鱼)+ 词标(jade→ink 渐变),贴在一起作 logo
  const taiji = renderTaiji(caps, bg);
  const tw = TAIJI_WIDTH(caps);
  taiji.forEach((row) => out.push(centerColored(row, tw, cols)));
  const wm = gradientBlock(WORDMARK, "jade", "ink", caps, bg);
  WORDMARK.forEach((raw, i) => out.push(centerColored(wm[i]!, displayWidth(raw), cols)));

  blank();
  // 品牌 + 版本落款(「道」已由朱印承担)
  const sealRaw = `DAO CODE  ·  v${info.version}`;
  const sealLine = `${P("DAO CODE", "jade")}  ${P("·", "dim")}  ${P(`v${info.version}`, "dim")}`;
  out.push(centerColored(sealLine, displayWidth(sealRaw), cols));

  // 随机名句(去掉出处,大家都知道老子)
  const m = randomMaxim(rng);
  const quoteRaw = `「${m.text}」`;
  out.push(centerColored(P(quoteRaw, "jade"), displayWidth(quoteRaw), cols));

  blank();
  // 信息块(整块居中):模型/上下文 一行,目录/分支 一行
  const l1Raw = `模型 ${info.model} · ${info.thinking} · 1M 上下文`;
  const branchPart = info.branch ? `   ⎇ ${info.branch}` : "";
  const l2Raw = `目录 ${shortenPath(info.cwd)}${branchPart}`;
  const blockW = Math.max(displayWidth(l1Raw), displayWidth(l2Raw));
  const indent = " ".repeat(Math.max(0, Math.floor((cols - blockW) / 2)));
  const l1 =
    `${P("模型", "dim")} ${P(info.model, "ink")}` +
    ` ${P("·", "dim")} ${P(info.thinking, "ink")}` +
    ` ${P("·", "dim")} ${P("1M 上下文", "ink")}`;
  const l2 =
    `${P("目录", "dim")} ${P(shortenPath(info.cwd), "ink")}` +
    (info.branch ? `   ${P(`⎇ ${info.branch}`, "jade")}` : "");
  out.push(indent + l1);
  out.push(indent + l2);

  blank();
  // 水墨分隔(随终端加宽,填得更满)+ 提示
  const ruleW = Math.min(Math.max(40, cols - 8), 100);
  const ruleRaw = "╌".repeat(ruleW);
  out.push(centerColored(P(ruleRaw, "dim"), ruleW, cols));
  const tipRaw = "输入消息开始 · /help 命令 · @ 引用文件 · Esc 打断";
  out.push(centerColored(P(tipRaw, "dim"), displayWidth(tipRaw), cols));
  blank();

  return out.join("\n");
}
