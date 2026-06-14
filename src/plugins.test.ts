import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPlugins, installPlugin, removePlugin, pluginComponentDirs } from "./plugins.js";

let root: string, src: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "dao-plugins-"));
  src = await fs.mkdtemp(path.join(os.tmpdir(), "dao-plugsrc-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(src, { recursive: true, force: true });
});

describe("loadPlugins", () => {
  it("读 plugin.json,定位 skills 目录;无 manifest 的跳过", async () => {
    await fs.mkdir(path.join(root, "p1", "skills"), { recursive: true });
    await fs.writeFile(path.join(root, "p1", "plugin.json"), JSON.stringify({ name: "p1", description: "演示插件" }));
    await fs.mkdir(path.join(root, "notaplugin"), { recursive: true }); // 无 plugin.json
    const plugins = await loadPlugins(root);
    expect(plugins.length).toBe(1);
    expect(plugins[0]!.name).toBe("p1");
    expect(plugins[0]!.description).toBe("演示插件");
    expect(plugins[0]!.skillsDir).toBe(path.join(root, "p1", "skills"));
  });
  it("根不存在 → 空", async () => {
    expect(await loadPlugins(path.join(root, "nope"))).toEqual([]);
  });
  it("多组件:存在 commands/ agents/ hooks.json 时填充对应字段", async () => {
    const p = path.join(root, "multi");
    await fs.mkdir(path.join(p, "skills"), { recursive: true });
    await fs.mkdir(path.join(p, "commands"), { recursive: true });
    await fs.mkdir(path.join(p, "agents"), { recursive: true });
    await fs.writeFile(path.join(p, "hooks.json"), "{}");
    await fs.writeFile(path.join(p, "plugin.json"), JSON.stringify({ name: "multi", description: "多组件" }));
    const [info] = await loadPlugins(root);
    expect(info!.skillsDir).toBe(path.join(p, "skills"));
    expect(info!.commandsDir).toBe(path.join(p, "commands"));
    expect(info!.agentsDir).toBe(path.join(p, "agents"));
    expect(info!.hooksFile).toBe(path.join(p, "hooks.json"));
  });
  it("仅 skills/ → command/agent/hook 字段为 undefined", async () => {
    const p = path.join(root, "skonly");
    await fs.mkdir(path.join(p, "skills"), { recursive: true });
    await fs.writeFile(path.join(p, "plugin.json"), JSON.stringify({ name: "skonly", description: "纯技能" }));
    const [info] = await loadPlugins(root);
    expect(info!.skillsDir).toBe(path.join(p, "skills"));
    expect(info!.commandsDir).toBeUndefined();
    expect(info!.agentsDir).toBeUndefined();
    expect(info!.hooksFile).toBeUndefined();
  });
});

describe("pluginComponentDirs", () => {
  it("聚合各组件并过滤 undefined", async () => {
    const full = path.join(root, "full");
    await fs.mkdir(path.join(full, "skills"), { recursive: true });
    await fs.mkdir(path.join(full, "commands"), { recursive: true });
    await fs.mkdir(path.join(full, "agents"), { recursive: true });
    await fs.writeFile(path.join(full, "hooks.json"), "{}");
    await fs.writeFile(path.join(full, "plugin.json"), JSON.stringify({ name: "full", description: "" }));
    const partial = path.join(root, "partial");
    await fs.mkdir(path.join(partial, "skills"), { recursive: true });
    await fs.writeFile(path.join(partial, "plugin.json"), JSON.stringify({ name: "partial", description: "" }));

    const plugins = await loadPlugins(root);
    const agg = pluginComponentDirs(plugins);
    expect(agg.skillDirs.sort()).toEqual([path.join(full, "skills"), path.join(partial, "skills")].sort());
    expect(agg.commandDirs).toEqual([path.join(full, "commands")]);
    expect(agg.agentDirs).toEqual([path.join(full, "agents")]);
    expect(agg.hookFiles).toEqual([path.join(full, "hooks.json")]);
  });
});

describe("installPlugin(本地路径)", () => {
  it("缺 plugin.json → 提示,不安装", async () => {
    let out = "";
    await installPlugin(src, (s) => { out += s; });
    expect(out).toContain("缺 plugin.json");
  });
});
