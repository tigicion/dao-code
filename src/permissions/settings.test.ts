import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSettings, mergePermissions, loadPermissions, emptyPermissions, enterpriseSettingsPath, extractCliPermissions, removeRule, setAutoSensitiveAllow } from "./settings.js";

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
  it("解析 autoMode 规则(allow/deny/environment)", () => {
    const raw = JSON.stringify({
      permissions: {
        autoMode: {
          allow: ["运行测试和构建命令"],
          deny: ["禁止外泄数据到外部端点"],
          environment: ["项目使用 pnpm"],
        },
      },
    });
    const cfg = parseSettings(raw);
    expect(cfg.autoMode?.allow).toEqual(["运行测试和构建命令"]);
    expect(cfg.autoMode?.deny).toEqual(["禁止外泄数据到外部端点"]);
    expect(cfg.autoMode?.environment).toEqual(["项目使用 pnpm"]);
  });
  it("解析 autoSensitiveAllow 子开关", () => {
    expect(parseSettings(JSON.stringify({ permissions: { autoSensitiveAllow: true } })).autoSensitiveAllow).toBe(true);
    expect(parseSettings(JSON.stringify({ permissions: { autoSensitiveAllow: false } })).autoSensitiveAllow).toBe(false);
    expect(parseSettings("{}").autoSensitiveAllow).toBeUndefined();
  });
  it("mergePermissions:任一层的 true 即开启", () => {
    const a = { ...emptyPermissions() };
    const b = { ...emptyPermissions(), autoSensitiveAllow: true };
    expect(mergePermissions([a, b]).autoSensitiveAllow).toBe(true);
    expect(mergePermissions([{ ...emptyPermissions(), autoSensitiveAllow: false }, b]).autoSensitiveAllow).toBe(true);
    expect(mergePermissions([a, { ...emptyPermissions(), autoSensitiveAllow: false }]).autoSensitiveAllow).toBe(false);
  });
  it("setAutoSensitiveAllow 写入并保留其它字段", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dao-settings-"));
    const f = path.join(dir, "settings.local.json");
    await fs.writeFile(f, JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }));
    await setAutoSensitiveAllow(f, true);
    const obj = JSON.parse(await fs.readFile(f, "utf8"));
    expect(obj.permissions.autoSensitiveAllow).toBe(true);
    expect(obj.permissions.allow).toEqual(["Bash(ls:*)"]); // 其它字段保留
    await setAutoSensitiveAllow(f, false);
    expect(JSON.parse(await fs.readFile(f, "utf8")).permissions.autoSensitiveAllow).toBe(false);
  });
  it("bashClassifier 向后兼容:映射到 autoMode.deny", () => {
    const raw = JSON.stringify({
      permissions: {
        bashClassifier: ["禁止 rm -rf"],
      },
    });
    const cfg = parseSettings(raw);
    expect(cfg.bashClassifier).toEqual(["禁止 rm -rf"]);
    expect(cfg.autoMode?.deny).toEqual(["禁止 rm -rf"]);
  });
  it("bashClassifier 与 autoMode.deny 合并", () => {
    const raw = JSON.stringify({
      permissions: {
        bashClassifier: ["旧规则"],
        autoMode: { deny: ["新规则"] },
      },
    });
    const cfg = parseSettings(raw);
    expect(cfg.autoMode?.deny).toEqual(["新规则", "旧规则"]);
  });
  it("autoMode 部分字段缺失时只解析存在的", () => {
    const raw = JSON.stringify({
      permissions: {
        autoMode: { allow: ["只配了 allow"] },
      },
    });
    const cfg = parseSettings(raw);
    expect(cfg.autoMode?.allow).toEqual(["只配了 allow"]);
    expect(cfg.autoMode?.deny).toBeUndefined();
    expect(cfg.autoMode?.environment).toBeUndefined();
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
    expect(merged.config.deny).toEqual(["Bash(rm:*)"]);
    expect(merged.config.allow).toEqual(["Bash(npm:*)"]);
    expect(merged.config.defaultMode).toBe("acceptEdits"); // local 最高层
    // per-source 追踪:每条规则知道来自哪个文件
    expect(merged.sources.get("deny:Bash(rm:*)")).toBe(user);
    expect(merged.sources.get("allow:Bash(npm:*)")).toBe(local);
  });
});

describe("removeRule - 按文件删除规则", () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "dao-perm-")); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it("从指定文件删除规则,保留其它规则和字段", async () => {
    const file = path.join(dir, "settings.json");
    await fs.writeFile(file, JSON.stringify({
      permissions: { allow: ["Bash(npm:*)", "Read"], deny: ["Read(.env)"] },
      other: "keep",
    }));
    const removed = await removeRule(file, "Bash(npm:*)", "allow");
    expect(removed).toBe(true);
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    expect(raw.permissions.allow).toEqual(["Read"]);
    expect(raw.permissions.deny).toEqual(["Read(.env)"]);
    expect(raw.other).toBe("keep");
  });

  it("规则不存在 -> 返回 false,文件不变", async () => {
    const file = path.join(dir, "settings.json");
    await fs.writeFile(file, JSON.stringify({ permissions: { allow: ["Bash(npm:*)"] } }));
    const removed = await removeRule(file, "Bash(nonexistent:*)", "allow");
    expect(removed).toBe(false);
  });

  it("文件不存在 -> 返回 false", async () => {
    const removed = await removeRule(path.join(dir, "missing.json"), "Bash(npm:*)", "allow");
    expect(removed).toBe(false);
  });
});
