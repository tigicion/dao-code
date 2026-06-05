import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAlwaysApproved, appendAlwaysApproved } from "./store.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "codeds-approvals-"));
  file = path.join(dir, ".codeds", "approvals.json");
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("always-approved store", () => {
  it("returns an empty set when the file is missing", async () => {
    const set = await loadAlwaysApproved(file);
    expect(set.size).toBe(0);
  });

  it("persists and reloads approved tool names", async () => {
    await appendAlwaysApproved(file, "write_file");
    const set = await loadAlwaysApproved(file);
    expect(set.has("write_file")).toBe(true);
  });

  it("does not duplicate an already-approved tool", async () => {
    await appendAlwaysApproved(file, "write_file");
    await appendAlwaysApproved(file, "write_file");
    const raw = await fs.readFile(file, "utf8");
    expect(JSON.parse(raw)).toEqual(["write_file"]);
  });
});
