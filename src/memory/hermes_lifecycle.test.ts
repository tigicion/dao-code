import { describe, it, expect, vi } from "vitest";
import { MemoryProviderManager, redactValue, type ExternalMemoryProvider } from "./provider.js";
import { executeReview } from "../learning/background_review.js";
import { ToolRegistry } from "../tools/registry.js";
import { memoryTool, skillManageTool } from "../tools/hermes_memory.js";
import type { StreamChatOptions, AssistantMessage, StreamDelta } from "../client/types.js";
const identity = { profile: "p", workspace: "w", session: "s", actor: "main" };
const provider = (): ExternalMemoryProvider => ({ name: "contract", initialize: async () => { }, systemPromptBlock: () => "static", onTurnStart: async () => { }, prefetch: async () => "recall", syncTurn: async () => { }, shutdown: async () => { } });
describe("external memory lifecycle", () => {
    it("bounds a stuck recall without spawning more workers", async () => { const p = provider(), prefetch = vi.fn(() => new Promise<string>(() => { })); p.prefetch = prefetch; const m = new MemoryProviderManager(p, 5); expect(await m.turn("query", identity)).toBe(""); expect(await m.turn("query 2", identity)).toBe(""); expect(prefetch).toHaveBeenCalledTimes(1); });
    it("serializes completed turns, redacts every surface and preserves captured identity", async () => { const calls: unknown[] = []; const p = provider(); p.syncTurn = async (m, s) => { calls.push([m, s]); }; p.onMemoryWrite = async (w, s) => { calls.push([w, s]); }; p.onPreCompress = async (m, s) => { calls.push([m, s]); return true; }; const manager = new MemoryProviderManager(p); const scope = { ...identity }; manager.sync([{ role: "user", content: "password='abcd1234567890xy'" }, { role: "assistant", content: "yes", reasoningContent: "private chain" }], scope); manager.mirror({ apiKey: "do not transmit" }, scope); scope.session = "new"; await manager.precompress([{ role: "user", content: "sk-abcdefghijklmnopqrstuv" }], scope, true); await manager.shutdown(scope); expect(JSON.stringify(calls)).not.toContain("abcd1234567890xy"); expect(JSON.stringify(calls)).not.toContain("private chain"); expect(JSON.stringify(calls)).not.toContain("do not transmit"); expect(JSON.stringify(calls)).toContain('"session":"s"'); expect(redactValue({ password: "abc" })).toEqual({ password: "[REDACTED]" }); });
    it("strict precompress fails closed and optional failure records diagnostics", async () => { const p = provider(); p.onPreCompress = async () => false; const m = new MemoryProviderManager(p); await expect(m.precompress([], identity, true)).rejects.toThrow(/checkpoint/); await expect(m.precompress([], identity, false)).resolves.toBeUndefined(); });
    it("dispatches session and delegation hooks and drains in order", async () => { const trace: string[] = []; const p = provider(); p.onSessionEnd = async (s) => { trace.push(`end:${s.session}`); }; p.onSessionSwitch = async () => { trace.push("switch"); }; p.onDelegation = async () => { trace.push("delegation"); }; p.shutdown = async () => { trace.push("shutdown"); }; const m = new MemoryProviderManager(p); m.switch(identity, { ...identity, session: "next" }); m.delegation("done", identity); await m.shutdown({ ...identity, session: "next" }); expect(trace).toEqual(["end:s", "switch", "delegation", "end:next", "shutdown"]); });
});
describe("review dispatch and cancellation", () => {
    const gate = { decide: () => "allow" as const, decideAsync: async () => "allow" as const, requestBatch: async () => new Map<string, boolean>() };
    it("keeps advertised schema but executes only the review whitelist", async () => {
        const registry = new ToolRegistry();
        registry.register(memoryTool);
        registry.register(skillManageTool);
        const calls: StreamChatOptions[] = [];
        const writes = vi.fn(() => ({ success: true }));
        let n = 0;
        async function* stream(o: StreamChatOptions): AsyncGenerator<StreamDelta, AssistantMessage> { calls.push(o); n++; return n === 1 ? { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "Bash", arguments: '{"command":"echo forbidden"}' } }, { id: "b", type: "function", function: { name: "memory", arguments: '{"target":"user","operations":[{"action":"add","content":"concise"}]}' } }] } : { role: "assistant", content: "done" }; }
        const tools = [{ type: "function" as const, function: { name: "Bash", description: "shell", parameters: {} } }, ...registry.toApiTools()];
        const messages = [{ role: "system" as const, content: "frozen" }, { role: "user" as const, content: "question" }];
        await executeReview({ request: { baseUrl: "", apiKey: "", model: "test", messages, tools }, stream, registry, ctx: { workspaceRoot: "/tmp", memoryRuntime: { write: writes } as never }, gate, signal: new AbortController().signal, memory: true, skills: false, maxIterations: 16, inputBudget: 10000, onResult: () => { } });
        expect(calls[0]!.tools).toEqual(tools);
        expect(messages).toHaveLength(2);
        expect(writes).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(calls[1]!.messages)).toContain("not available to background review");
    });
    it("cannot write on a late canceled response or in a skill-only review", async () => {
        const registry = new ToolRegistry();
        registry.register(memoryTool);
        const writes = vi.fn();
        const abort = new AbortController();
        async function* stream(): AsyncGenerator<StreamDelta, AssistantMessage> { abort.abort(); return { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "memory", arguments: '{"target":"user","operations":[{"action":"add","content":"late"}]}' } }] }; }
        await executeReview({ request: { baseUrl: "", apiKey: "", model: "test", messages: [] }, stream, registry, ctx: { workspaceRoot: "/tmp", memoryRuntime: { write: writes } as never }, gate, signal: abort.signal, memory: false, skills: true, maxIterations: 16, inputBudget: 10000, onResult: () => { } });
        expect(writes).not.toHaveBeenCalled();
    });
    it("respects parent deny rules without interactive approval", async () => {
        const registry = new ToolRegistry();
        registry.register(memoryTool);
        const writes = vi.fn();
        let n = 0;
        async function* stream(): AsyncGenerator<StreamDelta, AssistantMessage> { return ++n === 1 ? { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "memory", arguments: '{"target":"user","operations":[{"action":"add","content":"denied"}]}' } }] } : { role: "assistant", content: "done" }; }
        await executeReview({ request: { baseUrl: "", apiKey: "", model: "test", messages: [] }, stream, registry, ctx: { workspaceRoot: "/tmp", memoryRuntime: { write: writes } as never }, gate: { ...gate, decide: () => "deny" }, signal: new AbortController().signal, memory: true, skills: false, maxIterations: 16, inputBudget: 10000, onResult: () => { } });
        expect(writes).not.toHaveBeenCalled();
    });
});
