import { displayWidth, padEnd } from "./width.js";
import { highlight } from "cli-highlight";

// 行内格式:`码`(青)、**粗**、*斜*。先按反引号切出代码段保护,其余做粗/斜替换。
function inline(text: string): string {
  return text
    .split(/(`[^`]+`)/g)
    .map((p) => {
      if (p.startsWith("`") && p.endsWith("`") && p.length >= 2) {
        return `\x1b[36m${p.slice(1, -1)}\x1b[39m`;
      }
      return p
        .replace(/\*\*(.+?)\*\*/g, "\x1b[1m$1\x1b[22m")
        .replace(/\*(.+?)\*/g, "\x1b[3m$1\x1b[23m");
    })
    .join("");
}

function parseRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

// 按显示宽度折行(CJK 友好):优先在空格处断,否则按列宽硬断;保留显式换行。返回若干物理行。
function wrapCell(s: string, width: number): string[] {
  const w = Math.max(1, width);
  const lines: string[] = [];
  let cur: string[] = []; // 当前行的码点
  let curW = 0;
  let lastSpace = -1; // cur 中最后一个空格的下标(可断点)
  for (const ch of s) {
    if (ch === "\n") { lines.push(cur.join("")); cur = []; curW = 0; lastSpace = -1; continue; }
    const cw = displayWidth(ch);
    if (curW + cw > w && cur.length > 0) {
      if (lastSpace >= 0 && lastSpace < cur.length - 1) {
        lines.push(cur.slice(0, lastSpace).join(""));
        cur = cur.slice(lastSpace + 1);
      } else {
        lines.push(cur.join(""));
        cur = [];
      }
      curW = displayWidth(cur.join(""));
      lastSpace = cur.lastIndexOf(" ");
    }
    cur.push(ch);
    curW += cw;
    if (ch === " ") lastSpace = cur.length - 1;
  }
  lines.push(cur.join(""));
  return lines.length ? lines : [""];
}

// 渲染表格:列宽自适应终端,超宽时按比例收缩并在单元格内折行(多物理行),保证边框不被终端硬折行打散。
function renderTable(rows: string[][], maxWidth: number): string {
  const header = rows[0] ?? [];
  const body = rows.slice(2);
  const cols = header.length;
  if (cols === 0) return "";
  // 1. 自然列宽(取该列各行最大显示宽度)。
  const nat: number[] = [];
  for (let c = 0; c < cols; c++) {
    let w = displayWidth(header[c] ?? "");
    for (const row of body) w = Math.max(w, displayWidth(row[c] ?? ""));
    nat[c] = Math.max(1, w);
  }
  // 2. 超出终端则按比例收缩到内容预算(总宽 = Σ列宽 + 边框开销 3*cols+1)。
  const overhead = 3 * cols + 1;
  const budget = Math.max(cols * 3, (maxWidth || 80) - overhead);
  let widths = nat.slice();
  const total = nat.reduce((a, b) => a + b, 0);
  if (total > budget) {
    const MIN = Math.min(8, Math.max(3, Math.floor(budget / cols)));
    widths = nat.map((w) => Math.max(MIN, Math.floor((w * budget) / total)));
    let over = widths.reduce((a, b) => a + b, 0) - budget;
    while (over > 0) {
      const mx = Math.max(...widths);
      const idx = widths.indexOf(mx);
      if (idx < 0 || mx <= MIN) break;
      widths[idx] = mx - 1; over--;
    }
  }
  const bar = (l: string, m: string, r: string) =>
    l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
  // 3. 单元格折行 → 同一逻辑行展开成 max(行高) 条物理行,逐行 padEnd 对齐。
  const renderRow = (cells: string[], bold = false): string => {
    const wrapped = widths.map((w, c) => wrapCell(String(cells[c] ?? ""), w));
    const h = Math.max(1, ...wrapped.map((x) => x.length));
    const phys: string[] = [];
    for (let k = 0; k < h; k++) {
      const parts = widths.map((w, c) => {
        const cell = padEnd(wrapped[c]![k] ?? "", w);
        return bold ? `\x1b[1m${cell}\x1b[22m` : cell;
      });
      phys.push("│ " + parts.join(" │ ") + " │");
    }
    return phys.join("\n");
  };
  return [
    bar("┌", "┬", "┐"),
    renderRow(header, true),
    bar("├", "┼", "┤"),
    ...body.map((r) => renderRow(r)),
    bar("└", "┴", "┘"),
  ].join("\n");
}

export function renderMarkdown(md: string, width?: number): string {
  // 表格折行用的可用宽度:留 2 列安全余量,避免恰好等宽时被终端再折一次。
  const tableWidth = Math.max(20, (width ?? process.stdout.columns ?? 80) - 2);
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    const fence = /^\s*```(\w+)?/.exec(line);
    if (fence) {
      const lang = fence[1] ?? "";
      i++;
      const code: string[] = [];
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) {
        code.push(lines[i]!);
        i++;
      }
      i++; // 跳过收尾 ```
      let body = code.join("\n");
      try {
        body = highlight(body, { language: lang || undefined, ignoreIllegals: true }); // 语法高亮
      } catch {
        body = `\x1b[2m${body}\x1b[22m`; // 未知语言/失败 → 整体灰显
      }
      for (const cl of body.split("\n")) out.push("  " + cl); // 缩进 2 空格
      continue;
    }

    if (
      /^\s*\|/.test(line) &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1]!)
    ) {
      const tbl: string[] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) {
        tbl.push(lines[i]!);
        i++;
      }
      out.push(renderTable(tbl.map(parseRow), tableWidth));
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push(`\x1b[1m\x1b[36m${inline(h[2]!)}\x1b[0m`);
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(`\x1b[2m${"─".repeat(40)}\x1b[22m`);
      i++;
      continue;
    }

    const bq = /^>\s?(.*)$/.exec(line);
    if (bq) {
      out.push(`\x1b[2m│\x1b[22m ${inline(bq[1]!)}`);
      i++;
      continue;
    }

    const bl = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bl) {
      out.push(`${bl[1]}• ${inline(bl[2]!)}`);
      i++;
      continue;
    }

    const nl = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
    if (nl) {
      out.push(`${nl[1]}${nl[2]}. ${inline(nl[3]!)}`);
      i++;
      continue;
    }

    out.push(line.trim() === "" ? "" : inline(line));
    i++;
  }
  return out.join("\n");
}
