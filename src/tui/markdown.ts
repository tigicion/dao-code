import { displayWidth, padEnd } from "./width.js";

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

function renderTable(rows: string[][]): string {
  const header = rows[0] ?? [];
  const body = rows.slice(2);
  const cols = header.length;
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let w = displayWidth(header[c] ?? "");
    for (const row of body) w = Math.max(w, displayWidth(row[c] ?? ""));
    widths[c] = w;
  }
  const bar = (l: string, m: string, r: string) =>
    l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
  const renderRow = (cells: string[], bold = false) =>
    "│ " +
    widths
      .map((w, c) => {
        const padded = padEnd(cells[c] ?? "", w);
        return bold ? `\x1b[1m${padded}\x1b[22m` : padded;
      })
      .join(" │ ") +
    " │";
  return [
    bar("┌", "┬", "┐"),
    renderRow(header, true),
    bar("├", "┼", "┤"),
    ...body.map((r) => renderRow(r)),
    bar("└", "┴", "┘"),
  ].join("\n");
}

export function renderMarkdown(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    if (/^\s*```/.test(line)) {
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) {
        out.push(`\x1b[2m  ${lines[i]}\x1b[22m`);
        i++;
      }
      i++;
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
      out.push(renderTable(tbl.map(parseRow)));
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
