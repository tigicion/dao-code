import { describe, it, expect } from "vitest";
import { compactMessages, estimateTokens, shouldCompact, compressionRatio, stripImagesFromMessages } from "./compact.js";
import type { ChatMessage } from "../client/types.js";
const system: ChatMessage = { role: "system", content: "system" };
const transcript = (): ChatMessage[] => [system, ...Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" as const : "user" as const, content: `message ${i}`, archiveId: `m${i}` }))];
describe("Hermes compaction", () => {
    it("retains all results with their final multi-call assistant when over budget", async () => {
        const m = transcript();
        const calls = ["a", "b", "c"].map(id => ({ id, type: "function" as const, function: { name: "Read", arguments: "{}" } }));
        m.push({ role: "assistant", content: null, tool_calls: calls });
        for (const call of calls) m.push({ role: "tool", tool_call_id: call.id, content: "X".repeat(60000) });
        const out = await compactMessages(m, { summarize: async () => "summary", maxTokens: 4000, protectLastN: 2 });
        const assistant = out.findIndex(x => x.role === "assistant" && x.tool_calls?.[0]?.id === "a");
        expect(assistant).toBeGreaterThan(0);
        expect(out.slice(assistant + 1).map(x => x.role === "tool" ? x.tool_call_id : "orphan")).toEqual(["a", "b", "c"]);
        expect(m.at(-1)?.content?.length).toBe(60000);
    });
    it("leaves short contexts alone", async () => { const m = [system]; expect(await compactMessages(m, { summarize: async () => "x" })).toBe(m); });
    it("summarizes earlier evidence, retains recent raw messages and pins tasks", async () => { const m = transcript(); let seen: ChatMessage[] = []; const out = await compactMessages(m, { summarize: async (x) => { seen = x; return "earlier summary"; }, archiveAvailable: true }, "finish tests"); expect(out[0]).toBe(system); expect(out[1]?.content).toContain("earlier summary"); expect(out[1]?.content).toContain("session_search"); expect(out.some(x => typeof x.content === "string" && x.content.includes("finish tests"))).toBe(true); expect(out.slice(-20)).toEqual(m.slice(-20)); expect(seen).toEqual(m.slice(0, 21)); });
    it("resummarizes old summary instead of concatenating it forever", async () => { const m = transcript(); m.splice(1, 0, { role: "system", origin: "compaction", content: "previous summary" }); let input = ""; const out = await compactMessages(m, { summarize: async (x) => { input = JSON.stringify(x); return "merged summary"; } }); expect(input).toContain("previous summary"); expect(out[1]?.content).toContain("merged summary"); expect(out[1]?.content).not.toContain("previous summary"); });
    it("summary failure still retains recent raw context and task list", async () => { const m = transcript(); const out = await compactMessages(m, { summarize: async () => { throw new Error("offline"); }, archiveAvailable: true }, "task"); expect(out[1]?.content).toContain("Summary unavailable"); expect(out.slice(-20)).toEqual(m.slice(-20)); expect(out[1]?.content).toContain("m19"); });
    it("never produces orphan tool results", async () => { const m = transcript(); m.push({ role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "Read", arguments: "{}" } }] }, { role: "tool", tool_call_id: "c", content: "result" }, { role: "assistant", content: "done" }); const out = await compactMessages(m, { summarize: async () => "summary", protectLastN: 2 }); const tool = out.findIndex(x => x.role === "tool"); if (tool >= 0)
        expect(out[tool - 1]?.role).toBe("assistant"); expect(out.some(x => x.role === "user")).toBe(true); });
    it("bounds huge tool results without mutating archived evidence", async () => { const m = transcript(); m.push({ role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "Read", arguments: "{}" } }] }, { role: "tool", tool_call_id: "c", content: "X".repeat(60000), archiveId: "large" }); const out = await compactMessages(m, { summarize: async () => "summary", maxTokens: 32000 }); expect(estimateTokens(out)).toBeLessThan(estimateTokens(m)); expect(m.at(-1)?.content?.length).toBe(60000); });
    it("uses .75 floor on small contexts and .5 on large ones", () => { expect(compressionRatio(128000)).toBe(.75); expect(compressionRatio(1000000)).toBe(.5); expect(shouldCompact([{ role: "user", content: "a".repeat(2400) }], 1000)).toBe(true); });
    it("strips images from summarizer payload and counts tool arguments", () => { expect(stripImagesFromMessages([{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,aa" } }] }])[0]?.content).toEqual([{ type: "text", text: "[image]" }]); expect(estimateTokens([{ role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "Read", arguments: '{"path":"a"}' } }] }])).toBeGreaterThan(0); });
});
