import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPlugins, installPlugin, removePlugin } from "./plugins.js";

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
});

describe("installPlugin(本地路径)", () => {
  it("缺 plugin.json → 提示,不安装", async () => {
    let out = "";
    await installPlugin(src, (s) => { out += s; });
    expect(out).toContain("缺 plugin.json");
  });
});
