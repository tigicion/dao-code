import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadMemoryFile, loadAllMemories, addMemory } from "./store.js";

let dir: string;
let projectFile: string;
let userFile: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "codeds-mem-"));
  projectFile = path.join(dir, "proj", ".codeds", "memory", "memories.json");
  userFile = path.join(dir, "user", ".codeds", "memory", "memories.json");
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("memory store", () => {
  it("returns [] when the file is missing", async () => {
    expect(await loadMemoryFile(projectFile)).toEqual([]);
  });

  it("adds a memory and loads it back", async () => {
    const added = await addMemory(projectFile, "本项目用 vitest");
    expect(added).toBe(true);
    expect(await loadMemoryFile(projectFile)).toEqual([{ text: "本项目用 vitest" }]);
  });

  it("dedups an identical memory (trim-equal)", async () => {
    await addMemory(projectFile, "fact A");
    const again = await addMemory(projectFile, "  fact A  ");
    expect(again).toBe(false);
    expect(await loadMemoryFile(projectFile)).toHaveLength(1);
  });

  it("rejects empty text", async () => {
    expect(await addMemory(projectFile, "   ")).toBe(false);
    expect(await loadMemoryFile(projectFile)).toEqual([]);
  });

  it("loadAllMemories merges user then project", async () => {
    await addMemory(userFile, "user fact");
    await addMemory(projectFile, "project fact");
    const all = await loadAllMemories(projectFile, userFile);
    expect(all.map((m) => m.text)).toEqual(["user fact", "project fact"]);
  });

  it("tolerates a corrupt file", async () => {
    await fs.mkdir(path.dirname(projectFile), { recursive: true });
    await fs.writeFile(projectFile, "{not json", "utf8");
    expect(await loadMemoryFile(projectFile)).toEqual([]);
  });
});
