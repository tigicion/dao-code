import type { Capabilities } from "./capabilities.js";
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
const WORDMARK = [
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

export function buildWelcome(info: WelcomeInfo, caps: Capabilities, rng?: () => number): string {
  const cols = caps.columns;
  const out: string[] = [];
  const blank = () => out.push("");

  blank();
  // 太极(程序化阴阳鱼)+ 词标(jade→ink 渐变),贴在一起作 logo
  const taiji = renderTaiji(caps);
  const tw = TAIJI_WIDTH(caps);
  taiji.forEach((row) => out.push(centerColored(row, tw, cols)));
  const wm = gradientBlock(WORDMARK, "jade", "ink", caps);
  WORDMARK.forEach((raw, i) => out.push(centerColored(wm[i]!, displayWidth(raw), cols)));

  blank();
  // 朱砂"道"落款 + 品牌 + 副标题 + 版本
  const sealRaw = `【道】  DAO CODE  ·  DeepSeek V4 编码之道  ·  v${info.version}`;
  const sealLine =
    `${paint("【道】", "vermilion", caps)}  ${paint("DAO CODE", "jade", caps)}` +
    `  ${paint("·", "dim", caps)}  ${paint("DeepSeek V4 编码之道", "dim", caps)}` +
    `  ${paint("·", "dim", caps)}  ${paint(`v${info.version}`, "dim", caps)}`;
  out.push(centerColored(sealLine, displayWidth(sealRaw), cols));

  // 随机名句(去掉出处,大家都知道老子)
  const m = randomMaxim(rng);
  const quoteRaw = `「${m.text}」`;
  out.push(centerColored(paint(quoteRaw, "jade", caps), displayWidth(quoteRaw), cols));

  blank();
  // 信息块(整块居中):模型/上下文 一行,目录/分支 一行
  const l1Raw = `模型 ${info.model} · ${info.thinking} · 1M 上下文`;
  const branchPart = info.branch ? `   ⎇ ${info.branch}` : "";
  const l2Raw = `目录 ${shortenPath(info.cwd)}${branchPart}`;
  const blockW = Math.max(displayWidth(l1Raw), displayWidth(l2Raw));
  const indent = " ".repeat(Math.max(0, Math.floor((cols - blockW) / 2)));
  const l1 =
    `${paint("模型", "dim", caps)} ${paint(info.model, "ink", caps)}` +
    ` ${paint("·", "dim", caps)} ${paint(info.thinking, "ink", caps)}` +
    ` ${paint("·", "dim", caps)} ${paint("1M 上下文", "ink", caps)}`;
  const l2 =
    `${paint("目录", "dim", caps)} ${paint(shortenPath(info.cwd), "ink", caps)}` +
    (info.branch ? `   ${paint(`⎇ ${info.branch}`, "jade", caps)}` : "");
  out.push(indent + l1);
  out.push(indent + l2);

  blank();
  // 水墨分隔 + 提示
  const ruleRaw = "╌".repeat(Math.min(48, Math.max(20, cols - 6)));
  out.push(centerColored(paint(ruleRaw, "dim", caps), displayWidth(ruleRaw), cols));
  const tipRaw = "输入消息开始 · /help 命令 · @ 引用文件 · Esc 打断";
  out.push(centerColored(paint(tipRaw, "dim", caps), displayWidth(tipRaw), cols));
  blank();

  return out.join("\n");
}
