import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { Session } from "../session/session.js";
import { DurableStore } from "../session/durable_store.js";
import { ToolRegistry } from "../tools/registry.js";
import { defineTool } from "../tools/types.js";
import { executeToolCalls } from "../tools/execute.js";
import { runTurn, type TurnDeps } from "./loop.js";
import { deferred, tick } from "./background_test_helpers.js";
import type { ToolCall } from "../client/types.js";

const call = (name: string, id = name): ToolCall => ({ id, type: "function", function: { name, arguments: "{}" } });
function fixture(calls: ToolCall[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "dao-loop-recovery-"));
  const store = new DurableStore(dir, "test", dir, {
    current: () => ({ host: "test", boot: "boot", pid: 1, start: "test" }), alive: () => false,
  });
  const session = new Session("SYS", "m"); session.addUser("start");
  const registry = new ToolRegistry();
  const save = () => store.save({ id: "test", cwd: dir, model: "m", mode: "normal", messages: session.messages,
    usage: { ...session.usage }, updatedAt: Date.now(), done: false });
  const deps: TurnDeps = {
    session, registry, ctx: { workspaceRoot: dir, durableStore: store },
    config: { baseUrl: "https://unused", apiKey: "unused" },
    gate: { decide: () => "allow", decideAsync: async () => "allow", requestBatch: async () => new Map() },
    write: () => {}, executeToolCalls, onCheckpoint: save,
    streamChat: (() => (async function* () { return { role: "assistant" as const, content: null, tool_calls: calls }; })()) as TurnDeps["streamChat"],
  };
  return { store, session, registry, deps, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

describe("durable turn failure recovery", () => {
  it("keeps successful results, pairs rejected calls, and accepts the next turn after resolution", async () => {
    const f = fixture([call("Read"), call("Write")]);
    try {
      const write = vi.fn(async () => "written");
      f.registry.register(defineTool({ name: "Read", description: "test", capability: "read", approval: "auto", schema: z.object({}), handler: async () => "known result" }));
      f.registry.register(defineTool({ name: "Write", description: "test", capability: "write", approval: "auto", schema: z.object({}), handler: write }));
      f.store.beforeTool({ scope: "root", id: "old", name: "Write", args: "{}" }, true);
      f.store.markInterruptedTools();
      expect(await runTurn(f.deps)).toMatchObject({ kind: "failed" });
      expect(write).not.toHaveBeenCalled();
      expect(f.session.messages.slice(-2).map(({archiveId: _id, archiveSession: _scope, createdAt: _at, ...m}) => m)).toEqual([
        { role: "tool", tool_call_id: "Read", content: "known result" },
        { role: "tool", tool_call_id: "Write", content: expect.stringContaining("未执行") },
      ]);
      expect(f.store.state()?.messages).toEqual(f.session.messages);
      f.store.resolveTool("root", "old", "已核实");
      f.session.addUser("continue");
      const next = vi.fn<TurnDeps["streamChat"]>(() => (async function* () { return { role: "assistant", content: "done" } as const; })());
      expect(await runTurn({ ...f.deps, streamChat: next })).toEqual({ kind: "completed" });
      expect(next).toHaveBeenCalledOnce();
    } finally { f.close(); }
  });

  it("waits for in-flight tools and marks only this turn's uncommitted outcomes unknown", async () => {
    const f = fixture([call("Read", "failed"), call("Read", "slow")]);
    const done = deferred<void>();
    try {
      let calls = 0;
      f.registry.register(defineTool({ name: "Read", description: "test", capability: "read", approval: "auto", schema: z.object({}), handler: async () => {
        if (++calls === 2) await done.promise;
        return "read result";
      } }));
      f.store.beforeTool({ scope: "live-agent", id: "running", name: "Read", args: "{}" }, false);
      const commit = f.store.afterTool.bind(f.store);
      vi.spyOn(f.store, "afterTool").mockImplementation((scope, id, result) => {
        if (id === "failed") throw new Error("commit failed");
        commit(scope, id, result);
      });
      let settled = false;
      const turn = runTurn(f.deps).then(result => { settled = true; return result; });
      await tick(); expect(settled).toBe(false);
      done.resolve(); expect(await turn).toMatchObject({ kind: "failed" });
      expect(f.session.messages.slice(-2).map(({archiveId: _id, archiveSession: _scope, createdAt: _at, ...m}) => m)).toEqual([
        { role: "tool", tool_call_id: "failed", content: expect.stringContaining("结果未知") },
        { role: "tool", tool_call_id: "slow", content: "read result" },
      ]);
      expect(f.store.unresolved().map(r => r.id)).toEqual(["failed"]);
      expect(f.store.toolRecords().find(r => r.scope === "live-agent")?.state).toBe("started");
    } finally { done.resolve(); f.close(); }
  });

  it("repairs in-memory history conservatively even when the journal cannot be read or saved", async () => {
    const f = fixture([call("Read")]);
    try {
      f.registry.register(defineTool({ name: "Read", description: "test", capability: "read", approval: "auto", schema: z.object({}), handler: async () => "read" }));
      vi.spyOn(f.store, "toolRecords").mockImplementation(() => { throw new Error("storage unavailable"); });
      const saveError = new Error("disk full");
      expect(await runTurn({ ...f.deps, onCheckpoint: () => { throw saveError; } })).toMatchObject({ kind: "failed", error: saveError });
      expect(f.session.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "Read", content: expect.stringContaining("结果未知") });
    } finally { f.close(); }
  });
});
