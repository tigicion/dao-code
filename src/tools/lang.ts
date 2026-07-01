import { getLang } from "../i18n/i18n.js";

// 工具 handler 返回用:按当前语言返回对应文本。
export function msg(zh: string, en: string): string {
  return getLang() === "en" ? en : zh;
}
