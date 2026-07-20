import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { editFileTool } from "./edit_file.js";

let root: string;
let abs: string;
function ctx() {
  return { workspaceRoot: root, readFiles: new Set([abs]) };
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "dao-editfile-"));
  abs = path.join(root, "f.txt");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("Edit tool", () => {
  it("replaces a unique occurrence", async () => {
    await fs.writeFile(abs, "alpha beta gamma", "utf8");
    const out = await editFileTool.handler({ path: "f.txt", old_string: "beta", new_string: "BETA" }, ctx());
    expect(out).toContain("1");
    expect(await fs.readFile(abs, "utf8")).toBe("alpha BETA gamma");
  });

  it("parallel edits on same file: both succeed (file lock serialization)", async () => {
    await fs.writeFile(abs, "A\nB", "utf8");
    const c = ctx();
    await Promise.all([
      editFileTool.handler({ path: "f.txt", old_string: "A", new_string: "X" }, c),
      editFileTool.handler({ path: "f.txt", old_string: "B", new_string: "Y" }, c),
    ]);
    expect(await fs.readFile(abs, "utf8")).toBe("X\nY");
  });

  it("replaces all occurrences when replace_all is set", async () => {
    await fs.writeFile(abs, "x x x", "utf8");
    const out = await editFileTool.handler(
      { path: "f.txt", old_string: "x", new_string: "y", replace_all: true },
      ctx(),
    );
    expect(await fs.readFile(abs, "utf8")).toBe("y y y");
  });

  it("throws when old_string is not found", async () => {
    await fs.writeFile(abs, "hello", "utf8");
    await expect(
      editFileTool.handler({ path: "f.txt", old_string: "nope", new_string: "x" }, ctx()),
    ).rejects.toThrow();
  });

  it("old_string with wrong punctuation (full-width vs half-width) is matched via normalization", async () => {
    // File has em dash (U+2014), old_string uses ASCII hyphens (U+002D).
    // findActualString normalizes lookalike characters and matches successfully.
    await fs.writeFile(abs, "\u514D\u4E00\u6B21\u5BA1\u6279\u2014\u2014\u4E0B\u4E00\u6B65", "utf8");
    const result = await editFileTool.handler(
      { path: "f.txt", old_string: "\u514D\u4E00\u6B21\u5BA1\u6279--\u4E0B\u4E00\u6B65", new_string: "done" },
      ctx(),
    );
    expect(result).toContain("done");
    expect(await fs.readFile(abs, "utf8")).toBe("done");
  });

  it("throws when old_string is not unique and replace_all is off", async () => {
    await fs.writeFile(abs, "x x", "utf8");
    await expect(
      editFileTool.handler({ path: "f.txt", old_string: "x", new_string: "y" }, ctx()),
    ).rejects.toThrow();
  });

  it("requires the file to have been read", async () => {
    await fs.writeFile(abs, "hello", "utf8");
    await expect(
      editFileTool.handler(
        { path: "f.txt", old_string: "hello", new_string: "hi" },
        { workspaceRoot: root, readFiles: new Set() },
      ),
    ).rejects.toThrow();
  });

  it("treats $ in new_string literally (no replacement-pattern interpretation)", async () => {
    await fs.writeFile(abs, "price PLACEHOLDER end", "utf8");
    const out = await editFileTool.handler(
      { path: "f.txt", old_string: "PLACEHOLDER", new_string: "$100 & $& and $1" },
      ctx(),
    );
    expect(await fs.readFile(abs, "utf8")).toBe("price $100 & $& and $1 end");
  });

  it("declares write capability and required approval", () => {
    expect(editFileTool.capability).toBe("write");
    expect(editFileTool.approval).toBe("required");
    expect(editFileTool.name).toBe("Edit");
  });
});
