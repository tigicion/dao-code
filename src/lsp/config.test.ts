import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadLspConfig, resolveServerForFile } from "./config.js";

describe("loadLspConfig", () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "dao-lsp-test-")); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it("读一个配置文件", async () => {
    const f = path.join(dir, "lsp.json");
    await fs.writeFile(f, JSON.stringify({ servers: { typescript: { command: "typescript-language-server", args: ["--stdio"], extensions: [".ts"] } } }));
    const cfg = await loadLspConfig([f]);
    expect(cfg.servers?.typescript?.command).toBe("typescript-language-server");
  });

  it("多个文件按顺序合并,后面的覆盖同名 server", async () => {
    const f1 = path.join(dir, "a.json");
    const f2 = path.join(dir, "b.json");
    await fs.writeFile(f1, JSON.stringify({ servers: { ts: { command: "user-ts", extensions: [".ts"] } } }));
    await fs.writeFile(f2, JSON.stringify({ servers: { ts: { command: "project-ts", extensions: [".ts"] } } }));
    const cfg = await loadLspConfig([f1, f2]);
    expect(cfg.servers?.ts?.command).toBe("project-ts");
  });

  it("不存在的文件 → 跳过,不报错", async () => {
    const cfg = await loadLspConfig([path.join(dir, "不存在.json")]);
    expect(cfg.servers).toEqual({});
  });

  it("非法 JSON → 跳过,不报错", async () => {
    const f = path.join(dir, "bad.json");
    await fs.writeFile(f, "{not valid json");
    const cfg = await loadLspConfig([f]);
    expect(cfg.servers).toEqual({});
  });
});

describe("resolveServerForFile", () => {
  const cfg = { servers: { typescript: { command: "tsserver", extensions: [".ts", ".tsx"] }, python: { command: "pyright", extensions: [".py"] } } };

  it("按扩展名匹配到对应 server", () => {
    expect(resolveServerForFile(cfg, "src/index.ts")?.name).toBe("typescript");
    expect(resolveServerForFile(cfg, "src/App.tsx")?.name).toBe("typescript");
    expect(resolveServerForFile(cfg, "main.py")?.name).toBe("python");
  });

  it("扩展名不分大小写", () => {
    expect(resolveServerForFile(cfg, "FOO.TS")?.name).toBe("typescript");
  });

  it("没配置的扩展名 → undefined", () => {
    expect(resolveServerForFile(cfg, "main.go")).toBeUndefined();
  });
});
