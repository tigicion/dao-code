import { describe, it, expect } from "vitest";
import { z } from "zod";
import { toJsonSchema } from "./schema.js";

describe("toJsonSchema", () => {
  it("converts a zod object to a clean JSON schema without $schema", () => {
    const schema = z.object({
      path: z.string(),
      limit: z.number().int().optional(),
    });
    const json = toJsonSchema(schema) as any;
    expect(json.$schema).toBeUndefined();
    expect(json.type).toBe("object");
    expect(json.properties.path.type).toBe("string");
    expect(json.required).toContain("path");
    expect(json.required).not.toContain("limit");
  });
});
