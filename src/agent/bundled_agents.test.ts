import { describe, it, expect } from "vitest";
import { BUNDLED_AGENTS } from "./bundled_agents.js";

describe("BUNDLED_AGENTS", () => {
  it("含 explore 与 verify,各有描述/prompt/工具白名单", () => {
    const names = BUNDLED_AGENTS.map((a) => a.name);
    expect(names).toContain("explore");
    expect(names).toContain("verify");
    for (const a of BUNDLED_AGENTS) {
      expect(a.description).toBeTruthy();
      expect(a.prompt.length).toBeGreaterThan(50);
      expect(a.tools && a.tools.length).toBeTruthy();
    }
  });
  it("explore 只读(不含写/执行工具),verify 能执行", () => {
    const explore = BUNDLED_AGENTS.find((a) => a.name === "explore")!;
    expect(explore.tools).not.toContain("write_file");
    expect(explore.tools).not.toContain("exec_shell");
    const verify = BUNDLED_AGENTS.find((a) => a.name === "verify")!;
    expect(verify.tools).toContain("exec_shell");
  });
});
