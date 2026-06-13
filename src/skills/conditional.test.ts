import { describe, it, expect } from "vitest";
import { extractOperatedPaths, matchPath, makeActivator } from "./conditional.js";
import type { Skill } from "./skills.js";

const sk = (name: string, paths: string[]): Skill => ({ name, description: `${name} desc`, paths, body: `# ${name}\n做 ${name} 的事`, dir: "" });

describe("extractOperatedPaths", () => {
  it("从 read/write/edit/multi_edit 取 path,忽略 grep/无关工具", () => {
    const calls = [
      { id: "1", type: "function" as const, function: { name: "read_file", arguments: JSON.stringify({ path: "src/a.tsx" }) } },
      { id: "2", type: "function" as const, function: { name: "edit_file", arguments: JSON.stringify({ path: "src/b.ts" }) } },
      { id: "3", type: "function" as const, function: { name: "grep_files", arguments: JSON.stringify({ pattern: "x", path: "src" }) } },
      { id: "4", type: "function" as const, function: { name: "exec_shell", arguments: JSON.stringify({ cmd: "ls" }) } },
    ];
    expect(extractOperatedPaths(calls)).toEqual(["src/a.tsx", "src/b.ts"]);
  });
  it("坏 JSON 不抛", () => {
    expect(extractOperatedPaths([{ id: "1", type: "function", function: { name: "read_file", arguments: "{bad" } }])).toEqual([]);
  });
});

describe("matchPath (gitignore 风格)", () => {
  it("无斜杠模式按 basename 任意层命中", () => {
    expect(matchPath("src/components/Button.tsx", ["*.tsx"])).toBe(true);
    expect(matchPath("Button.tsx", ["*.tsx"])).toBe(true);
    expect(matchPath("src/a.ts", ["*.tsx"])).toBe(false);
  });
  it("带斜杠模式按根相对路径命中", () => {
    expect(matchPath("src/components/Button.tsx", ["src/components/**"])).toBe(true);
    expect(matchPath("src/utils/x.ts", ["src/components/**"])).toBe(false);
  });
});

describe("makeActivator", () => {
  it("命中 glob 才激活,且每个技能只激活一次", () => {
    const skills = [sk("tsx-conv", ["*.tsx"]), sk("api-conv", ["src/api/**"])];
    const act = makeActivator(skills);
    const first = act.activate(["src/Button.tsx"]);
    expect(first.map((s) => s.name)).toEqual(["tsx-conv"]);
    // 再碰 tsx 不重复激活
    expect(act.activate(["other.tsx"])).toEqual([]);
    // 碰 api 路径激活第二个
    expect(act.activate(["src/api/users.ts"]).map((s) => s.name)).toEqual(["api-conv"]);
    expect(act.activated()).toEqual(new Set(["tsx-conv", "api-conv"]));
  });
  it("无命中返回空", () => {
    const act = makeActivator([sk("tsx-conv", ["*.tsx"])]);
    expect(act.activate(["README.md"])).toEqual([]);
  });
});
