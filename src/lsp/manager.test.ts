import { describe, it, expect, afterEach } from "vitest";
import { LspManager } from "./manager.js";

// 只测路由/复用逻辑,不测真实协议(client.test.ts 已用真实 server 覆盖)——
// 用 "cat" 当 command 占位即可(manager 不关心它是不是真正的 LSP server,只负责按扩展名找到并缓存实例)。
const CFG = { servers: { typescript: { command: "cat", extensions: [".ts"] }, python: { command: "cat", extensions: [".py"] } } };

describe("LspManager", () => {
  let mgr: LspManager;
  afterEach(() => mgr?.disposeAll());

  it("没配置的扩展名 → 返回 error", () => {
    mgr = new LspManager(CFG, "file:///w");
    const r = mgr.resolve("main.go");
    expect("error" in r).toBe(true);
  });

  it("配置了的扩展名 → 返回 client", () => {
    mgr = new LspManager(CFG, "file:///w");
    const r = mgr.resolve("src/index.ts");
    expect("client" in r).toBe(true);
  });

  it("同一语言重复 resolve → 复用同一个 client 实例(不重新 spawn)", () => {
    mgr = new LspManager(CFG, "file:///w");
    const a = mgr.resolve("src/a.ts");
    const b = mgr.resolve("src/b.ts");
    expect("client" in a && "client" in b).toBe(true);
    if ("client" in a && "client" in b) expect(a.client).toBe(b.client);
  });

  it("不同语言 → 不同 client 实例", () => {
    mgr = new LspManager(CFG, "file:///w");
    const ts = mgr.resolve("src/a.ts");
    const py = mgr.resolve("main.py");
    if ("client" in ts && "client" in py) expect(ts.client).not.toBe(py.client);
  });
});
