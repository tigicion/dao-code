import { describe, it, expect } from "vitest";
import { auditEnabled } from "./audit_switch.js";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("auditEnabled", () => {
  it("默认开:DAO_AUDIT 未设 → true", () => {
    expect(auditEnabled(env({}), "MEMORY")).toBe(true);
  });
  it("DAO_AUDIT=0 → 全关", () => {
    expect(auditEnabled(env({ DAO_AUDIT: "0" }), "TOOL")).toBe(false);
  });
  it("DAO_<X>_AUDIT 覆盖优先", () => {
    expect(auditEnabled(env({ DAO_AUDIT: "0", DAO_TOOL_AUDIT: "1" }), "TOOL")).toBe(true);
    expect(auditEnabled(env({ DAO_AUDIT: "1", DAO_CACHE_AUDIT: "0" }), "CACHE")).toBe(false);
  });
});
