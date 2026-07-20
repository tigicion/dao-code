import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { multiEditTool } from "./multi_edit.js";

let root: string, abs: string;
const ctx = () => ({ workspaceRoot: root, readFiles: new Set([abs]) });
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "dao-multiedit-")); abs = path.join(root, "f.txt"); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("MultiEdit", () => {
  it("applies edits in order", async () => {
    await fs.writeFile(abs, "A B C", "utf8");
    const out = await multiEditTool.handler({ path: "f.txt", edits: [
      { old_string: "A", new_string: "X" },
      { old_string: "C", new_string: "Z" },
    ] }, ctx());
    expect(out).toContain("2");
    expect(await fs.readFile(abs, "utf8")).toBe("X B Z");
  });

  it("any failure -> nothing written (atomic)", async () => {
    await fs.writeFile(abs, "A B C", "utf8");
    await expect(multiEditTool.handler({ path: "f.txt", edits: [
      { old_string: "A", new_string: "X" },
      { old_string: "NOPE", new_string: "Z" },
    ] }, ctx())).rejects.toThrow();
    expect(await fs.readFile(abs, "utf8")).toBe("A B C"); // unchanged
  });

  it("not unique without replace_all -> error, nothing written", async () => {
    await fs.writeFile(abs, "x x", "utf8");
    await expect(multiEditTool.handler({ path: "f.txt", edits: [{ old_string: "x", new_string: "y" }] }, ctx()))
      .rejects.toThrow();
    expect(await fs.readFile(abs, "utf8")).toBe("x x");
  });

  it("old_string with wrong punctuation matched via normalization (atomic, all edits succeed)", async () => {
    // File has em dash (U+2014), old_string uses ASCII hyphens (U+002D).
    // findActualString normalizes lookalike characters; both edits succeed atomically.
    await fs.writeFile(abs, "A \u514D\u4E00\u6B21\u5BA1\u6279\u2014\u2014\u4E0B\u4E00\u6B65", "utf8");
    const out = await multiEditTool.handler({ path: "f.txt", edits: [
      { old_string: "A", new_string: "X" },
      { old_string: "\u514D\u4E00\u6B21\u5BA1\u6279--\u4E0B\u4E00\u6B65", new_string: "done" },
    ] }, ctx());
    expect(out).toContain("2");
    expect(await fs.readFile(abs, "utf8")).toBe("X done");
  });
});
