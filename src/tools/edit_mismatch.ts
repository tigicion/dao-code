// old_string 精确匹配失败时的兜底诊断:Edit/MultiEdit 按字节精确比对,模型"凭记忆"复述代码里的
// 标点时常把全角/半角、直弯引号、连字符家族(-/－/—/–/−)、不换行空格等写岔,肉眼看着一样但一个
// 字符不同就整段找不到——而报错只说"未找到",模型没法知道是内容错了还是标点写岔了,容易放弃 Edit
// 转去写更能容忍这种偏差的东西(如 shell/python 脚本),反而绕开了权限审批的快速路径。
// 这里在精确匹配失败后,放宽这类形近字符再匹配一次:命中就说明问题出在标点/空白,把具体是
// 哪一个字符、文件里实际是什么标出来,而不是让调用方瞎猜。

// 形近字符组:每组内的字符视觉相似、常被互相写错;组内首个视为"随便举例",不表示谁是权威写法。
const LOOKALIKE_GROUPS: readonly (readonly string[])[] = [
  ["-", "－", "—", "–", "−"],
  ['"', "“", "”"],
  ["'", "‘", "’"],
  [",", "，", "、"],
  [".", "。"],
  [":", "："],
  [";", "；"],
  ["(", "（"],
  [")", "）"],
  [" ", " ", "　"],
];

const LOOKALIKE_CLASS = new Map<string, string>(); // 单字符 -> 覆盖整组的正则字符类(已转义)
for (const group of LOOKALIKE_GROUPS) {
  const cls = `[${group.map((c) => c.replace(/[\]\\^-]/g, "\\$&")).join("")}]`;
  for (const c of group) LOOKALIKE_CLASS.set(c, cls);
}

const RE_SPECIAL = /[.*+?^${}()|[\]\\]/g;

// old_string 太长时构造/匹配的收益不大,直接跳过诊断(仍然只是"锦上添花",不影响主流程正确性)。
const MAX_DIAGNOSE_LEN = 5000;

// 把 old_string 编译成"容忍形近标点差异"的正则:普通字符照常转义,形近组内的字符替换成整组的
// 字符类。只用于失败后的诊断,绝不用于真正的匹配放行——放行仍然要求字节级精确匹配。
function buildLookalikePattern(oldString: string): RegExp | null {
  if (oldString.length === 0 || oldString.length > MAX_DIAGNOSE_LEN) return null;
  let pattern = "";
  for (const ch of oldString) pattern += LOOKALIKE_CLASS.get(ch) ?? ch.replace(RE_SPECIAL, "\\$&");
  try { return new RegExp(pattern); } catch { return null; }
}

// 返回 null = 没找到"形近但不完全相同"的诊断线索(调用方按普通"未找到"处理)。
export function findActualString(fileContent: string, searchString: string): string | null {
  if (!searchString) return null;
  if (fileContent.includes(searchString)) return searchString;
  const re = buildLookalikePattern(searchString);
  if (!re) return null;
  const m = re.exec(fileContent);
  if (!m) return null;
  return m[0]!;
}

export function diagnoseMismatch(raw: string, oldString: string): string | null {
  const re = buildLookalikePattern(oldString);
  if (!re) return null;
  const m = re.exec(raw);
  if (!m) return null;
  const found = m[0]!;
  for (let i = 0; i < oldString.length; i++) {
    if (oldString[i] !== found[i]) {
      const want = oldString[i]!;
      const have = found[i]!;
      const hex = (c: string) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
      return `old_string 第 ${i + 1} 个字符是"${want}"(${hex(want)}),文件里对应位置实际是"${have}"(${hex(have)})——` +
        `像是全角/半角标点、直弯引号或连字符写法不同,不是内容本身有出入。请从 Read 的原始输出里逐字符复制该处文本,不要凭记忆改写标点。`;
    }
  }
  return null; // 理论上不会到这:能匹配上又逐字符相同就该是精确匹配,矛盾;稳妥兜底不报诊断
}
