import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { KeyStep } from "./KeyStep.js";
import { setLang } from "../../../i18n/i18n.js";

const ENTER = "\r";
const delay = (ms = 30) => new Promise((r) => setTimeout(r, ms));
beforeEach(() => setLang("en"));
const meta = { baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro" };

describe("KeyStep", () => {
  it("validates a typed key then onDone", async () => {
    const validate = vi.fn(async () => ({ ok: true } as const));
    const onDone = vi.fn(); const onAbort = vi.fn();
    const { stdin, lastFrame } = render(
      <KeyStep bg="dark" provider="deepseek" meta={meta} validate={validate} onDone={onDone} onAbort={onAbort} />,
    );
    expect(lastFrame()).toContain("platform.deepseek.com");
    stdin.write("sk-abc"); await delay();
    stdin.write(ENTER); await delay(50);
    expect(validate).toHaveBeenCalledWith({ baseUrl: meta.baseUrl, key: "sk-abc", provider: "deepseek" });
    expect(onDone).toHaveBeenCalledWith("sk-abc");
  });
  it("shows the reason and stays on failure, not onDone", async () => {
    const validate = vi.fn(async () => ({ ok: false, reason: "invalid" } as const));
    const onDone = vi.fn(); const onAbort = vi.fn();
    const { stdin, lastFrame } = render(
      <KeyStep bg="dark" provider="deepseek" meta={meta} validate={validate} onDone={onDone} onAbort={onAbort} />,
    );
    stdin.write("sk-bad"); await delay(); stdin.write(ENTER); await delay(50);
    expect(onDone).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("invalid");
  });
  it("empty Enter aborts", async () => {
    const validate = vi.fn(); const onDone = vi.fn(); const onAbort = vi.fn();
    const { stdin } = render(
      <KeyStep bg="dark" provider="deepseek" meta={meta} validate={validate as any} onDone={onDone} onAbort={onAbort} />,
    );
    stdin.write(ENTER); await delay();
    expect(onAbort).toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
  });
});
