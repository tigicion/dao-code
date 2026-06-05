import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileSearchTool } from "./file_search.js";

let root: string;
function ctx() {
  return { workspaceRoot: root };
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codeds-filesearch-"));
  await fs.writeFile(path.join(root, "old.ts"), "x", "utf8");
  await fs.writeFile(path.join(root, "new.ts"), "y", "utf8");
  await fs.mkdir(path.join(root, "sub"));
  await fs.writeFile(path.join(root, "sub", "deep.ts"), "z", "utf8");
  await fs.writeFile(path.join(root, "note.md"), "m", "utf8");
  await fs.utimes(path.join(root, "old.ts"), new Date(1000), new Date(1000));
  await fs.utimes(path.join(root, "new.ts"), new Date(2000), new Date(2000));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("file_search tool", () => {
  it("finds top-level files by glob, newest first", async () => {
    const out = await fileSearchTool.handler({ glob: "*.ts" }, ctx());
    const lines = out.split("\n");
    expect(lines).toEqual(["new.ts", "old.ts"]);
  });

  it("finds nested files with ** glob", async () => {
    const out = await fileSearchTool.handler({ glob: "**/*.ts" }, ctx());
    expect(out).toContain(path.join("sub", "deep.ts"));
    expect(out).toContain("new.ts");
  });

  it("returns (无匹配) when nothing matches", async () => {
    const out = await fileSearchTool.handler({ glob: "*.json" }, ctx());
    expect(out).toBe("(无匹配)");
  });

  it("declares read capability and auto approval", () => {
    expect(fileSearchTool.capability).toBe("read");
    expect(fileSearchTool.approval).toBe("auto");
    expect(fileSearchTool.name).toBe("file_search");
  });
});
