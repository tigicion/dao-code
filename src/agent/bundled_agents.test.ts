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
    }
    // explore/verify 用工具白名单(其余内置如 general-purpose/plan 走全集±排除)。
    for (const name of ["explore", "verify"]) {
      const a = BUNDLED_AGENTS.find((x) => x.name === name)!;
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

describe("BUNDLED_AGENTS general-purpose/plan", () => {
  it("含 general-purpose(全工具、模型跟随会话=未设)", () => {
    const g = BUNDLED_AGENTS.find((a) => a.name === "general-purpose")!;
    expect(g).toBeDefined();
    expect(g.tools).toBeUndefined();       // 继承全部工具
    expect(g.toolsExclude).toBeUndefined();
    expect(g.model).toBeUndefined();       // 跟随主会话模型(默认 pro)
    expect(g.prompt.length).toBeGreaterThan(20);
  });
  it("含 plan(只读+设计:排除写/执行类工具)", () => {
    const p = BUNDLED_AGENTS.find((a) => a.name === "plan")!;
    expect(p.tools).toBeUndefined();
    expect(new Set(p.toolsExclude)).toEqual(new Set([
      "edit_file", "write_file", "multi_edit", "notebook_edit",
      "exec_shell", "exec_shell_poll", "exec_shell_kill",
    ]));
    expect(p.model).toBeUndefined(); // 规划要强推理 → 跟随会话(pro)
  });
});
