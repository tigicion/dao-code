import { describe, it, expect } from "vitest";
import { newMemory } from "./types.js";

describe("newMemory", () => {
  it("fills defaults", () => {
    const m = newMemory({ name: "uses-pnpm", text: "用 pnpm", type: "semantic", today: "2026-06-07" });
    expect(m).toMatchObject({
      name: "uses-pnpm", text: "用 pnpm", type: "semantic",
      importance: 5, status: "active", created: "2026-06-07", lastUsed: "2026-06-07",
    });
    expect(m.locked).toBe(false);
  });
});
