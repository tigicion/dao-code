import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { Select } from "./Select.js";

const DOWN = "\x1B[B", UP = "\x1B[A", ENTER = "\r";
const items = [{ label: "中文", value: "zh" }, { label: "English", value: "en" }];
const delay = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("Select", () => {
  it("highlights initialIndex and selects it on Enter", async () => {
    const onSelect = vi.fn();
    const { stdin, lastFrame } = render(<Select items={items} initialIndex={1} bg="dark" onSelect={onSelect} />);
    expect(lastFrame()).toContain("▸ English");
    stdin.write(ENTER); await delay();
    expect(onSelect).toHaveBeenCalledWith("en");
  });
  it("moves with arrows and wraps", async () => {
    const onSelect = vi.fn();
    const { stdin, lastFrame } = render(<Select items={items} bg="dark" onSelect={onSelect} />);
    expect(lastFrame()).toContain("▸ 中文");
    stdin.write(DOWN); await delay();
    expect(lastFrame()).toContain("▸ English");
    stdin.write(DOWN); await delay();           // 环绕回第一项
    expect(lastFrame()).toContain("▸ 中文");
    stdin.write(UP); await delay();              // 上箭头环绕到末项
    expect(lastFrame()).toContain("▸ English");
    stdin.write(ENTER); await delay();
    expect(onSelect).toHaveBeenCalledWith("en");
  });
});
