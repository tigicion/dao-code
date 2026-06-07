import { describe, it, expect } from "vitest";
import { contentHash } from "./hash.js";
describe("contentHash", () => {
  it("stable + sensitive", () => {
    expect(contentHash("abc")).toBe(contentHash("abc"));
    expect(contentHash("abc")).not.toBe(contentHash("abd"));
    expect(contentHash("abc")).toMatch(/^[0-9a-f]{16}$/);
  });
});
