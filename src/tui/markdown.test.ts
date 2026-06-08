import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./markdown.js";
import { displayWidth } from "./width.js";

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("renderMarkdown", () => {
  it("renders a header in bold (text preserved)", () => {
    const out = renderMarkdown("# 标题");
    expect(strip(out)).toContain("标题");
    expect(out).toContain("\x1b[1m");
  });

  it("renders inline bold and inline code", () => {
    const out = renderMarkdown("这是 **粗** 和 `码`");
    expect(out).toContain("\x1b[1m粗");
    expect(out).toContain("\x1b[36m码");
  });

  it("renders a fenced code block (content preserved, no inline processing)", () => {
    const out = renderMarkdown("```\nconst a = 1; // **不加粗**\n```");
    // 代码块内容原样保留,且不做行内 markdown 处理(** 不应变成粗体)。
    expect(strip(out)).toContain("const a = 1; // **不加粗**");
    expect(out).not.toContain("\x1b[1m");
  });

  it("renders bullets", () => {
    const out = renderMarkdown("- 一\n- 二");
    expect(strip(out)).toContain("• 一");
    expect(strip(out)).toContain("• 二");
  });

  it("renders a CJK table with aligned columns", () => {
    const md = "| 名字 | 城市 |\n|---|---|\n| 张三 | 北京 |\n| 李 | 上海市 |";
    const out = renderMarkdown(md);
    const lines = strip(out).split("\n");
    expect(lines.some((l) => l.includes("┌"))).toBe(true);
    expect(lines.some((l) => l.includes("张三"))).toBe(true);
    const body = lines.filter((l) => l.startsWith("│") && (l.includes("张三") || l.includes("李")));
    expect(body).toHaveLength(2);
    expect(displayWidth(body[0]!)).toBe(displayWidth(body[1]!));
  });
});
