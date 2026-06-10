import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCustomCommands, expandCommand } from "./custom.js";

describe("expandCommand", () => {
  it("$ARGUMENTS 替换全部参数", () => {
    expect(expandCommand("修复 bug:$ARGUMENTS", "登录页崩溃")).toBe("修复 bug:登录页崩溃");
  });
  it("$1/$2 替换位置参数", () => {
    expect(expandCommand("把 $1 改成 $2", "foo bar")).toBe("把 foo 改成 bar");
  });
});

describe("loadCustomCommands", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(path.join(os.tmpdir(), "dao-cmds-"));
  });
  it("加载 .md;项目覆盖用户;解析 description", async () => {
    const proj = path.join(base, "p");
    const user = path.join(base, "u");
    mkdirSync(proj, { recursive: true });
    mkdirSync(user, { recursive: true });
    writeFileSync(path.join(user, "review.md"), `---\ndescription: 审查\n---\n审查 $ARGUMENTS`);
    writeFileSync(path.join(proj, "review.md"), `项目版审查 $ARGUMENTS`);
    const cmds = await loadCustomCommands(proj, user);
    expect(cmds.get("review")?.body).toBe("项目版审查 $ARGUMENTS"); // 项目覆盖
    expect(cmds.size).toBe(1);
  });
});
