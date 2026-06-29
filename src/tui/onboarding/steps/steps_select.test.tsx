import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { LanguageStep } from "./LanguageStep.js";
import { ProviderStep } from "./ProviderStep.js";
import { setLang, getLang } from "../../../i18n/i18n.js";

const DOWN = "\x1B[B", ENTER = "\r";
const delay = (ms = 30) => new Promise((r) => setTimeout(r, ms));
beforeEach(() => setLang("en"));

describe("LanguageStep", () => {
  it("defaults to `initial` and setLang+onPick on Enter", async () => {
    const onPick = vi.fn();
    const { stdin, lastFrame } = render(<LanguageStep bg="dark" initial="zh" onPick={onPick} />);
    expect(lastFrame()).toContain("▸ 中文");
    stdin.write(ENTER); await delay();
    expect(onPick).toHaveBeenCalledWith("zh");
    expect(getLang()).toBe("zh");
  });
});

describe("ProviderStep", () => {
  it("picks volcengine after one DOWN", async () => {
    const onPick = vi.fn();
    const { stdin } = render(<ProviderStep bg="dark" onPick={onPick} />);
    stdin.write(DOWN); await delay(); stdin.write(ENTER); await delay();
    expect(onPick).toHaveBeenCalledWith("volcengine");
  });
});
