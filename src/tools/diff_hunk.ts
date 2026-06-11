// 由"字符串替换"型编辑生成带行号+上下文的 diff 行(复刻 CC diff 观感)。
// 每行形如 " 12 ctx" / "-12 old" / "+12 new":首字符是符号(空格=上下文,-=删,+=增),随后是行号与文本。
// 单处替换:取首个 old_string 出现位置;old/new 各自计行号。old_string 找不到返回空。
export function buildEditHunk(raw: string, oldStr: string, newStr: string, ctx = 3): string[] {
  const idx = raw.indexOf(oldStr);
  if (idx < 0) return [];
  const next = raw.slice(0, idx) + newStr + raw.slice(idx + oldStr.length);
  const beforeLines = raw.split("\n");
  const afterLines = next.split("\n");
  const startLine = raw.slice(0, idx).split("\n").length; // 1-based:改动起始行
  const endBefore = raw.slice(0, idx + oldStr.length).split("\n").length; // 改动占的最后一行(旧)
  const endAfter = next.slice(0, idx + newStr.length).split("\n").length; // 改动占的最后一行(新)
  const pad = (n: number) => String(n).padStart(4);
  const rows: string[] = [];
  const aboveStart = Math.max(0, startLine - 1 - ctx);
  let bn = aboveStart + 1;
  for (const l of beforeLines.slice(aboveStart, startLine - 1)) rows.push(` ${pad(bn++)} ${l}`);
  let on = startLine;
  for (const l of beforeLines.slice(startLine - 1, endBefore)) rows.push(`-${pad(on++)} ${l}`);
  let nn = startLine;
  for (const l of afterLines.slice(startLine - 1, endAfter)) rows.push(`+${pad(nn++)} ${l}`);
  let an = endAfter + 1;
  for (const l of afterLines.slice(endAfter, endAfter + ctx)) rows.push(` ${pad(an++)} ${l}`);
  return rows;
}
