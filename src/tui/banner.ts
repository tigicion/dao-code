import type { Capabilities } from "./capabilities.js";
import { paint, gradientBlock } from "./theme.js";
import { randomMaxim } from "./maxim.js";
import { displayWidth } from "./width.js";

export interface WelcomeInfo {
  model: string;
  thinking: string;
  mode: string;
  memories: number;
  cwd: string;
  version: string;
}

// 太极初始美术(半块字符;后续 preview 目视微调)。
const TAIJI = [
  "      ▄▀▀▀▀▀▄",
  "    ▄▀  ▄▄▄  ▀▄",
  "   █   █████   █",
  "   █   ▀▀▀▀▀   █",
  "   █   ▄▄▄▄▄   █",
  "    ▀▄  ▀▀▀  ▄▀",
  "      ▀▄▄▄▄▄▀",
];

// DAO CODE 词标(ANSI Shadow 风格,初始稿)。
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

export function buildWelcome(info: WelcomeInfo, caps: Capabilities, rng?: () => number): string {
  const cols = caps.columns;
  const out: string[] = [];
  const blank = () => out.push("");

  blank();
  // 太极(灰阶 dim):按原始行宽(去 ANSI)居中
  TAIJI.forEach((row) => out.push(centerColored(paint(row, "dim", caps), displayWidth(row), cols)));

  blank();
  // 词标(jade→ink 渐变),按原始行宽居中
  const wm = gradientBlock(WORDMARK, "jade", "ink", caps);
  WORDMARK.forEach((raw, i) => out.push(centerColored(wm[i]!, displayWidth(raw), cols)));

  blank();
  // 朱砂"道"落款 + 副标题 + 品牌名
  const seal = paint("【道】", "vermilion", caps);
  const brand = paint("DAO CODE", "jade", caps);
  const sub = paint("DeepSeek V4 编码之道", "dim", caps);
  const sealLine = `${seal}  ${brand}  ${sub}`;
  out.push(centerColored(sealLine, displayWidth("【道】  DAO CODE  DeepSeek V4 编码之道"), cols));

  blank();
  // 随机名句
  const m = randomMaxim(rng);
  const quoteRaw = `「${m.text}」`;
  out.push(centerColored(paint(quoteRaw, "jade", caps), displayWidth(quoteRaw), cols));
  const byRaw = `— 老子 · 第${m.chapter}章`;
  out.push(centerColored(paint(byRaw, "dim", caps), displayWidth(byRaw), cols));

  blank();
  // 信息行(左对齐到一个统一缩进)
  const indent = "   ";
  const line = (label: string, value: string) =>
    `${indent}${paint(label, "dim", caps)} ${paint(value, "ink", caps)}`;
  out.push(line("模型", `${info.model} · ${info.thinking}`));
  out.push(line("模式", `${info.mode}      记忆 ${info.memories} 条`));
  out.push(line("目录", `${info.cwd}      v${info.version}`));

  blank();
  // 水墨分隔
  const ruleRaw = "╌".repeat(Math.min(48, Math.max(20, cols - 6)));
  out.push(centerColored(paint(ruleRaw, "dim", caps), displayWidth(ruleRaw), cols));

  // 提示行
  const tipRaw = "输入消息开始 · /help 命令 · @ 引用文件 · Esc 打断";
  out.push(centerColored(paint(tipRaw, "dim", caps), displayWidth(tipRaw), cols));
  blank();

  return out.join("\n");
}
