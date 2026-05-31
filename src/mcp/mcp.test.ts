import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadMcpConfig } from "./mcp.js";

let base: string;
beforeEach(() => {
  base = mkdtempSync(path.join(os.tmpdir(), "dao-mcp-"));
});

describe("loadMcpConfig", () => {
  it("合并多文件;非法/缺失跳过;项目覆盖", async () => {
    const userF = path.join(base, "user.json");
    const projF = path.join(base, "proj.json");
    writeFileSync(userF, JSON.stringify({ mcpServers: { a: { command: "x" }, b: { command: "y" } } }));
    writeFileSync(projF, JSON.stringify({ mcpServers: { a: { command: "覆盖" } } }));
    const cfg = await loadMcpConfig([userF, projF, path.join(base, "missing.json")]);
    expect(Object.keys(cfg.mcpServers!).sort()).toEqual(["a", "b"]);
    expect(cfg.mcpServers!.a!.command).toBe("覆盖"); // 后面的文件覆盖
  });

  it("无文件 → 空 server 表", async () => {
    const cfg = await loadMcpConfig([path.join(base, "none.json")]);
    expect(cfg.mcpServers).toEqual({});
  });
});
