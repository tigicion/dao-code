import { describe, it, expect } from "vitest";
import { Session } from "./session.js";

describe("Session", () => {
  it("starts with the system prompt and given model", () => {
    const s = new Session("SYS", "deepseek-v4-pro");
    expect(s.messages).toEqual([{ role: "system", content: "SYS" }]);
    expect(s.model).toBe("deepseek-v4-pro");
    expect(s.mode).toBe("normal");
  });

  it("appends user messages", () => {
    const s = new Session("SYS", "m");
    s.addUser("hi");
    expect(s.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "hi" },
    ]);
  });

  it("clear resets to just the system prompt", () => {
    const s = new Session("SYS", "m");
    s.addUser("a");
    s.messages.push({ role: "assistant", content: "b" });
    s.clear();
    expect(s.messages).toEqual([{ role: "system", content: "SYS" }]);
  });

  it("setModel changes the model without touching messages", () => {
    const s = new Session("SYS", "m");
    s.addUser("a");
    s.setModel("deepseek-v4-flash");
    expect(s.model).toBe("deepseek-v4-flash");
    expect(s.messages).toHaveLength(2);
  });

  it("toggleMode flips between normal and plan", () => {
    const s = new Session("SYS", "m");
    expect(s.toggleMode()).toBe("plan");
    expect(s.mode).toBe("plan");
    expect(s.toggleMode()).toBe("normal");
  });
});
