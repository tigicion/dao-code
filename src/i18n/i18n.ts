import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { zh, zhTips } from "./messages/zh.js";
import { en, enTips } from "./messages/en.js";

export type Lang = "zh" | "en";

const DICTS: Record<Lang, Record<string, string>> = { zh, en };
const TIPS: Record<Lang, string[]> = { zh: zhTips, en: enTips };

// 归一化一个显式语言值(DAO_LANG / settings.lang):zh*/zh-CN → zh;en → en;其余 → undefined(非法,忽略)。
function normExplicit(v: string | undefined): Lang | undefined {
  if (!v) return undefined;
  const s = v.toLowerCase();
  if (s.startsWith("zh")) return "zh";
  if (s.startsWith("en")) return "en";
  return undefined;
}

// 优先级:DAO_LANG > settingsLang > 系统 locale(LC_ALL||LC_MESSAGES||LANG)> 默认 en。
export function resolveLang(env: Record<string, string | undefined>, settingsLang?: string): Lang {
  return (
    normExplicit(env.DAO_LANG) ??
    normExplicit(settingsLang) ??
    (((env.LC_ALL || env.LC_MESSAGES || env.LANG || "").toLowerCase().startsWith("zh")) ? "zh" : "en")
  );
}

let current: Lang = "en";
export function setLang(l: Lang): void { current = l; }
export function getLang(): Lang { return current; }

// 查当前语言字典;缺 key → 返回 key 本身;{0}{1}… 位置插值。
export function t(key: string, ...args: (string | number)[]): string {
  const raw = DICTS[current][key] ?? key;
  return raw.replace(/\{(\d+)\}/g, (m, i) => (args[Number(i)] !== undefined ? String(args[Number(i)]) : m));
}

export function tips(): string[] { return TIPS[current]; }

// 读 ~/.dao/settings.json 顶层 lang;缺失/损坏/无字段 → undefined(容错,绝不抛)。
export async function readUserLang(): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(os.homedir(), ".dao", "settings.json"), "utf8");
    const v = (JSON.parse(raw) as { lang?: unknown }).lang;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}
