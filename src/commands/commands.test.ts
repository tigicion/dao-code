import { describe, it, expect } from "vitest";
import { dispatchCommand } from "./commands.js";
import { Session } from "../session/session.js";

function sess() {
  return new Session("SYS", "deepseek-v4-pro");
}

describe("dispatchCommand", () => {
  it("treats non-slash input as not a command", () => {
    expect(dispatchCommand("hello", sess()).handled).toBe(false);
  });

  it("/model with no arg toggles pro<->flash", () => {
    const s = sess();
    const r = dispatchCommand("/model", s);
    expect(r.handled).toBe(true);
    expect(s.model).toBe("deepseek-v4-flash");
    dispatchCommand("/model", s);
    expect(s.model).toBe("deepseek-v4-pro");
  });

  it("/model <id> sets the model", () => {
    const s = sess();
    dispatchCommand("/model deepseek-v4-flash", s);
    expect(s.model).toBe("deepseek-v4-flash");
  });

  it("/plan toggles mode", () => {
    const s = sess();
    dispatchCommand("/plan", s);
    expect(s.mode).toBe("plan");
    dispatchCommand("/plan", s);
    expect(s.mode).toBe("normal");
  });

  it("/clear resets the conversation", () => {
    const s = sess();
    s.addUser("a");
    dispatchCommand("/clear", s);
    expect(s.messages).toHaveLength(1);
  });

  it("/exit signals exit", () => {
    expect(dispatchCommand("/exit", sess()).exit).toBe(true);
  });

  it("/compact signals compaction", () => {
    const r = dispatchCommand("/compact", sess());
    expect(r.handled).toBe(true);
    expect(r.compact).toBe(true);
  });

  it("unknown command is handled with a hint", () => {
    const r = dispatchCommand("/wat", sess());
    expect(r.handled).toBe(true);
    expect(r.output).toContain("未知命令");
  });
});
