import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { TrustStep } from "./TrustStep.js";
import { setLang } from "../../../i18n/i18n.js";

const delay = (ms = 30) => new Promise((r) => setTimeout(r, ms));
beforeEach(() => setLang("en"));

describe("TrustStep", () => {
  it("y → trusted true", async () => {
    const onDecide = vi.fn();
    const { stdin, lastFrame } = render(<TrustStep bg="dark" root="/repo/x" onDecide={onDecide} />);
    expect(lastFrame()).toContain("/repo/x");
    stdin.write("y"); await delay();
    expect(onDecide).toHaveBeenCalledWith(true);
  });
  it("n → trusted false", async () => {
    const onDecide = vi.fn();
    const { stdin } = render(<TrustStep bg="dark" root="/repo/x" onDecide={onDecide} />);
    stdin.write("n"); await delay();
    expect(onDecide).toHaveBeenCalledWith(false);
  });
});
