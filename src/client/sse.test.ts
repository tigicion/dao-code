import { describe, it, expect } from "vitest";
import { parseSSEChunk } from "./sse.js";

describe("parseSSEChunk", () => {
  it("extracts a single complete data payload", () => {
    const r = parseSSEChunk('data: {"a":1}\n\n');
    expect(r.payloads).toEqual(['{"a":1}']);
    expect(r.rest).toBe("");
  });

  it("extracts multiple events in one chunk", () => {
    const r = parseSSEChunk('data: {"a":1}\n\ndata: {"b":2}\n\n');
    expect(r.payloads).toEqual(['{"a":1}', '{"b":2}']);
    expect(r.rest).toBe("");
  });

  it("keeps an incomplete trailing event in rest", () => {
    const r = parseSSEChunk('data: {"a":1}\n\ndata: {"b"');
    expect(r.payloads).toEqual(['{"a":1}']);
    expect(r.rest).toBe('data: {"b"');
  });

  it("passes through the [DONE] sentinel as a payload", () => {
    const r = parseSSEChunk("data: [DONE]\n\n");
    expect(r.payloads).toEqual(["[DONE]"]);
  });

  it("ignores non-data lines (comments, empty)", () => {
    const r = parseSSEChunk(": keep-alive\n\ndata: {\"a\":1}\n\n");
    expect(r.payloads).toEqual(['{"a":1}']);
  });
});
