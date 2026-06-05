import { describe, it, expect } from "vitest";
import { z } from "zod";
import { SessionApprovalGate } from "./gate.js";
import { defineTool } from "../tools/types.js";
import type { ApprovalDecision, ApprovalRequest } from "./types.js";

const readTool = defineTool({
  name: "read_file", description: "", capability: "read", approval: "auto",
  schema: z.object({}), handler: async () => "",
});
const writeTool = defineTool({
  name: "write_file", description: "", capability: "write", approval: "required",
  schema: z.object({}), handler: async () => "",
});

function req(id: string, toolName: string): ApprovalRequest {
  return { id, toolName, capability: "write", summary: `${toolName} {}` };
}
function promptReturning(map: Record<string, ApprovalDecision>): (r: ApprovalRequest[]) => Promise<Map<string, ApprovalDecision>> {
  return async (reqs) => new Map(reqs.map((x) => [x.id, map[x.id] ?? "deny"]));
}

describe("SessionApprovalGate", () => {
  it("auto-approval tools never need approval", () => {
    const gate = new SessionApprovalGate(promptReturning({}), new Set(), async () => {});
    expect(gate.needsApproval(readTool)).toBe(false);
  });

  it("required tools need approval by default", () => {
    const gate = new SessionApprovalGate(promptReturning({}), new Set(), async () => {});
    expect(gate.needsApproval(writeTool)).toBe(true);
  });

  it("a tool in the always set does not need approval", () => {
    const gate = new SessionApprovalGate(promptReturning({}), new Set(["write_file"]), async () => {});
    expect(gate.needsApproval(writeTool)).toBe(false);
  });

  it("once approves only this batch (no persistence)", async () => {
    const gate = new SessionApprovalGate(promptReturning({ a: "once" }), new Set(), async () => {});
    const res = await gate.requestBatch([req("a", "write_file")]);
    expect(res.get("a")).toBe(true);
    expect(gate.needsApproval(writeTool)).toBe(true);
  });

  it("session approves for the rest of the session", async () => {
    const gate = new SessionApprovalGate(promptReturning({ a: "session" }), new Set(), async () => {});
    await gate.requestBatch([req("a", "write_file")]);
    expect(gate.needsApproval(writeTool)).toBe(false);
  });

  it("always approves and persists", async () => {
    const persisted: string[] = [];
    const gate = new SessionApprovalGate(promptReturning({ a: "always" }), new Set(), async (n) => { persisted.push(n); });
    const res = await gate.requestBatch([req("a", "write_file")]);
    expect(res.get("a")).toBe(true);
    expect(persisted).toEqual(["write_file"]);
    expect(gate.needsApproval(writeTool)).toBe(false);
  });

  it("deny returns false and missing decisions default to deny", async () => {
    const gate = new SessionApprovalGate(promptReturning({ a: "deny" }), new Set(), async () => {});
    const res = await gate.requestBatch([req("a", "write_file"), req("b", "write_file")]);
    expect(res.get("a")).toBe(false);
    expect(res.get("b")).toBe(false);
  });
});
