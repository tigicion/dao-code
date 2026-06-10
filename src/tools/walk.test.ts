import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { walkFiles } from "./walk.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "dao-walk-"));
  await fs.writeFile(path.join(root, "a.txt"), "x", "utf8");
  await fs.mkdir(path.join(root, "sub"));
  await fs.writeFile(path.join(root, "sub", "b.txt"), "y", "utf8");
  await fs.mkdir(path.join(root, "node_modules"));
  await fs.writeFile(path.join(root, "node_modules", "skip.txt"), "z", "utf8");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function collect(root: string) {
  const out: string[] = [];
  for await (const f of walkFiles(root)) out.push(f.rel);
  return out.sort();
}

describe("walkFiles", () => {
  it("yields files recursively with relative paths", async () => {
    const rels = await collect(root);
    expect(rels).toContain("a.txt");
    expect(rels).toContain(path.join("sub", "b.txt"));
  });

  it("skips ignored directories like node_modules", async () => {
    const rels = await collect(root);
    expect(rels.some((r) => r.includes("node_modules"))).toBe(false);
  });
});
