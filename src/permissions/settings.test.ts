import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSettings, mergePermissions, loadPermissions, emptyPermissions, enterpriseSettingsPath, extractCliPermissions } from "./settings.js";

describe("parseSettings", () => {
  it("提取 permissions 块的各字段", () => {
    const raw = JSON.stringify({
      permissions: {
        allow: ["Bash(npm run test:*)"],
        ask: ["Edit(src/**)"],
        deny: ["Read(.env)"],
        additionalDirectories: ["/tmp/x"],
        defaultMode: "acceptEdits",
      },
    });
    expect(parseSettings(raw)).toEqual({
      allow: ["Bash(npm run test:*)"],
      ask: ["Edit(src/**)"],
      deny: ["Read(.env)"],
      additionalDirectories: ["/tmp/x"],
      defaultMode: "acceptEdits",
    });
  });
  it("缺 permissions / 损坏 JSON → 空配置", () => {
    expect(parseSettings("{}")).toEqual(emptyPermissions());
    expect(parseSettings("{bad")).toEqual(emptyPermissions());
  });
});

describe("mergePermissions — 低→高优先级", () => {
  it("allow/ask/deny/additionalDirectories 并集去重", () => {
    const merged = mergePermissions([
      { allow: ["Bash(a)"], ask: [], deny: ["Read(x)"], additionalDirectories: ["/a"] },
      { allow: ["Bash(a)", "Bash(b)"], ask: ["Edit(y)"], deny: [], additionalDirectories: ["/b"] },
    ]);
    expect(merged.allow.sort()).toEqual(["Bash(a)", "Bash(b)"]);
    expect(merged.ask).toEqual(["Edit(y)"]);
    expect(merged.deny).toEqual(["Read(x)"]);
    expect(merged.additionalDirectories.sort()).toEqual(["/a", "/b"]);
  });
  it("defaultMode 取最高层(后者)定义的值", () => {
    expect(mergePermissions([
      { ...emptyPermissions(), defaultMode: "default" },
      { ...emptyPermissions(), defaultMode: "plan" },
    ]).defaultMode).toBe("plan");
  });
  it("高层未定义 defaultMode 时沿用低层", () => {
    expect(mergePermissions([
      { ...emptyPermissions(), defaultMode: "acceptEdits" },
      emptyPermissions(),
    ]).defaultMode).toBe("acceptEdits");
  });
});

describe("enterpriseSettingsPath — 平台托管策略路径", () => {
  it("各平台返回托管策略文件路径", () => {
    expect(enterpriseSettingsPath("darwin")).toContain("Application Support");
    expect(enterpriseSettingsPath("linux")).toBe("/etc/dao/managed-settings.json");
    expect(enterpriseSettingsPath("win32")).toContain("ProgramData");
  });
});

describe("extractCliPermissions — 命令行规则/模式", () => {
  it("解析 --allow/--deny/--add-dir/--permission-mode,并从 rest 移除其本身与取值", () => {
    const { config, rest } = extractCliPermissions([
      "修复bug", "--deny", "Bash(rm:*)", "--allow", "Read", "--add-dir", "/x", "--permission-mode", "plan", "--yolo",
    ]);
    expect(config.deny).toEqual(["Bash(rm:*)"]);
    expect(config.allow).toEqual(["Read"]);
    expect(config.additionalDirectories).toEqual(["/x"]);
    expect(config.defaultMode).toBe("plan");
    expect(rest).toEqual(["修复bug", "--yolo"]); // 权限相关 flag+值已剔除,其它原样保留
  });
  it("无权限 flag → 空配置 + 原样 rest", () => {
    const { config, rest } = extractCliPermissions(["hello", "--yolo"]);
    expect(config).toEqual(emptyPermissions());
    expect(rest).toEqual(["hello", "--yolo"]);
  });
});

describe("loadPermissions — 文件分层(缺文件跳过)", () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "dao-perm-")); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it("按低→高合并存在的文件,deny 跨层累加", async () => {
    const user = path.join(dir, "user.json");
    const local = path.join(dir, "local.json");
    await fs.writeFile(user, JSON.stringify({ permissions: { deny: ["Bash(rm:*)"], defaultMode: "default" } }));
    await fs.writeFile(local, JSON.stringify({ permissions: { allow: ["Bash(npm:*)"], defaultMode: "acceptEdits" } }));
    const merged = await loadPermissions([user, path.join(dir, "missing.json"), local]);
    expect(merged.deny).toEqual(["Bash(rm:*)"]);
    expect(merged.allow).toEqual(["Bash(npm:*)"]);
    expect(merged.defaultMode).toBe("acceptEdits"); // local 最高层
  });
});
