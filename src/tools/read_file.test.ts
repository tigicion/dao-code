import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileTool } from "./read_file.js";

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codeds-readfile-"));
  await fs.writeFile(path.join(root, "a.txt"), "line1\nline2\nline3\n", "utf8");
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("read_file tool", () => {
  it("returns file content with 1-based line numbers", async () => {
    const out = await readFileTool.handler({ path: "a.txt" }, { workspaceRoot: root });
    expect(out).toContain("1\tline1");
    expect(out).toContain("2\tline2");
    expect(out).toContain("3\tline3");
  });

  it("honors offset and limit", async () => {
    const out = await readFileTool.handler({ path: "a.txt", offset: 2, limit: 1 }, { workspaceRoot: root });
    expect(out).toBe("2\tline2");
  });

  it("throws when the file is missing", async () => {
    await expect(
      readFileTool.handler({ path: "nope.txt" }, { workspaceRoot: root }),
    ).rejects.toThrow();
  });

  it("declares read capability and auto approval", () => {
    expect(readFileTool.capability).toBe("read");
    expect(readFileTool.approval).toBe("auto");
    expect(readFileTool.name).toBe("read_file");
  });

  it("rejects paths escaping the workspace", async () => {
    await expect(
      readFileTool.handler({ path: "../escape.txt" }, { workspaceRoot: root }),
    ).rejects.toThrow(/越界/);
  });

  it("records the read file's absolute path in ctx.readFiles", async () => {
    const seen = new Set<string>();
    await readFileTool.handler({ path: "a.txt" }, { workspaceRoot: root, readFiles: seen });
    expect(seen.has(path.join(root, "a.txt"))).toBe(true);
  });
});
