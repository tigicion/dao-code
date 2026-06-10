import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateLegacyDir } from "./migrate_dirs.js";

let root: string;
let oldDir: string;
let newDir: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "dao-migrate-"));
  oldDir = path.join(root, ".codeds");
  newDir = path.join(root, ".dao");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("migrateLegacyDir", () => {
  it("renames .codeds to .dao with contents intact", async () => {
    await fs.mkdir(path.join(oldDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(oldDir, "config.json"), "{}", "utf8");
    await fs.writeFile(path.join(oldDir, "memory", "a.md"), "fact", "utf8");

    expect(await migrateLegacyDir(oldDir, newDir)).toBe("migrated");

    expect(await fs.readFile(path.join(newDir, "config.json"), "utf8")).toBe("{}");
    expect(await fs.readFile(path.join(newDir, "memory", "a.md"), "utf8")).toBe("fact");
    await expect(fs.stat(oldDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is a no-op when the old dir does not exist", async () => {
    expect(await migrateLegacyDir(oldDir, newDir)).toBe("absent");
    await expect(fs.stat(newDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips and leaves both untouched when the new dir already exists", async () => {
    await fs.mkdir(oldDir, { recursive: true });
    await fs.writeFile(path.join(oldDir, "old.txt"), "old", "utf8");
    await fs.mkdir(newDir, { recursive: true });
    await fs.writeFile(path.join(newDir, "new.txt"), "new", "utf8");

    expect(await migrateLegacyDir(oldDir, newDir)).toBe("skipped");

    expect(await fs.readFile(path.join(oldDir, "old.txt"), "utf8")).toBe("old");
    expect(await fs.readFile(path.join(newDir, "new.txt"), "utf8")).toBe("new");
  });

  it("ignores an old path that is a file, not a directory", async () => {
    await fs.writeFile(oldDir, "not a dir", "utf8");
    expect(await migrateLegacyDir(oldDir, newDir)).toBe("absent");
    await expect(fs.stat(newDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
