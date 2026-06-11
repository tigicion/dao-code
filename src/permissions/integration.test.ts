import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { loadPermissions } from "./settings.js";
import { PermissionGate } from "./gate.js";
import { executeToolCalls } from "../tools/execute.js";
import { ToolRegistry } from "../tools/registry.js";
import { defineTool } from "../tools/types.js";
import type { ToolCall } from "../client/types.js";

// 端到端:settings.json(deny/allow)→ loadPermissions → PermissionGate → executeToolCalls。
// 证明 CC 的 deny>allow>默认 在真实执行链路上生效。
let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "dao-perm-int-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

function reg() {
  const r = new ToolRegistry();
  r.register(defineTool({
    name: "exec_shell", description: "", capability: "exec", approval: "required",
    schema: z.object({ command: z.string() }), handler: async () => "RAN",
  }));
  return r;
}
const exec = (id: string, command: string): ToolCall => ({
  id, type: "function", function: { name: "exec_shell", arguments: JSON.stringify({ command }) },
});

async function gateFor(promptAllows: boolean) {
  const file = path.join(dir, "settings.json");
  await fs.writeFile(file, JSON.stringify({
    permissions: { allow: ["Bash(npm run build)"], deny: ["Bash(rm -rf:*)"] },
  }));
  const perms = await loadPermissions([file]);
  let prompted = 0;
  const gate = new PermissionGate(
    () => "default",
    () => perms,
    async (reqs) => { prompted++; return new Map(reqs.map((r) => [r.id, promptAllows ? "once" : "deny" as const])); },
    async () => {},
    () => {},
  );
  return { gate, promptedCount: () => prompted };
}

describe("权限端到端", () => {
  const ctx = { workspaceRoot: dir } as any;

  it("deny 规则:rm -rf 被拦截,不询问、不执行", async () => {
    const { gate, promptedCount } = await gateFor(true);
    const out = await executeToolCalls([exec("a", "rm -rf /tmp/x")], reg(), { ...ctx, workspaceRoot: dir }, gate);
    expect(out[0]!.content).toContain("权限规则拒绝");
    expect(promptedCount()).toBe(0);
  });

  it("allow 规则:npm run build 直接放行,不询问", async () => {
    const { gate, promptedCount } = await gateFor(false);
    const out = await executeToolCalls([exec("a", "npm run build")], reg(), { ...ctx, workspaceRoot: dir }, gate);
    expect(out[0]!.content).toBe("RAN");
    expect(promptedCount()).toBe(0);
  });

  it("未匹配规则:exec 默认询问,拒绝则不执行", async () => {
    const { gate, promptedCount } = await gateFor(false);
    const out = await executeToolCalls([exec("a", "ls -la")], reg(), { ...ctx, workspaceRoot: dir }, gate);
    expect(out[0]!.content).toContain("用户拒绝");
    expect(promptedCount()).toBe(1);
  });
});
