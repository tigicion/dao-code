import React from "react";
import { describe, it, expect, beforeAll } from "vitest";
import { render } from "ink-testing-library";
import { Welcome } from "./Welcome.js";
import { setLang } from "../i18n/i18n.js";

// 页脚文案走 i18n(t()),默认随系统 locale → en；锁定 zh 以断言「快速开始」稳定。
beforeAll(() => setLang("zh"));

const props = {
  info: { model: "deepseek-v4-pro", thinking: "max", cwd: "/x/y/z", version: "0.2.0", branch: "main" },
  caps: { tier: "none" as const, isTTY: true, columns: 80 },
  bg: "dark" as const,
  maxim: { text: "上善若水", chapter: 8 },
};

describe("Welcome skipFooter", () => {
  it("renders the footer (快速开始) by default", () => {
    const { lastFrame } = render(<Welcome {...props} />);
    expect(lastFrame()).toContain("快速开始");
  });
  it("hides the footer when skipFooter", () => {
    const { lastFrame } = render(<Welcome {...props} skipFooter />);
    expect(lastFrame()).not.toContain("快速开始");
    expect(lastFrame()).toContain("DAO CODE"); // banner 仍在
  });
});
