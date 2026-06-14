// S1.1 Unicode 消毒:检测命令/路径里的同形字(homoglyph)、零宽/不可见字符、全角伪装。
// 不静默改写(改写会变语义),而是检测出"可疑"→ 上层据此强制确认或拒绝(fail-closed)。

// 允许的常规空白(命令里合法):制表/换行/回车。其余控制字符视为可疑。
const ALLOWED_WS = /[\t\n\r]/g;

// 是否含可疑 Unicode:格式控制(零宽等 Cf)、私用区(Co)、未分配(Cn)、其他控制(Cc),
// 或 NFKC 归一后发生变化(全角/同形伪装,如 ｒｍ→rm、Cyrillic а→a 不变但全角会变)。
export function hasSuspiciousUnicode(s: string): boolean {
  if (typeof s !== "string" || s === "") return false;
  if (s.includes("\0")) return true; // null 字节(路径截断攻击)
  const stripped = s.replace(ALLOWED_WS, "");
  if (/[\p{Cf}\p{Co}\p{Cn}\p{Cc}]/u.test(stripped)) return true;
  if (s.normalize("NFKC") !== s) return true; // 全角/兼容字符伪装
  return false;
}

// null 字节单独判定(路径用:即便不查全部 Unicode 也必须挡 null 字节)。
export function hasNullByte(s: string): boolean {
  return typeof s === "string" && s.includes("\0");
}
