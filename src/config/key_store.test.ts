import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadStoredKey, saveKey } from "./key_store.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "dao-keystore-"));
  file = path.join(dir, ".dao", "config.json");
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("key store", () => {
  it("returns undefined when the file is missing", async () => {
    expect(await loadStoredKey(file)).toBeUndefined();
  });
  it("saves and reloads the key (creating the dir)", async () => {
    await saveKey(file, "sk-saved");
    expect(await loadStoredKey(file)).toBe("sk-saved");
  });
  it("merges into existing config without losing other keys", async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ baseUrl: "x" }), "utf8");
    await saveKey(file, "sk-1");
    const obj = JSON.parse(await fs.readFile(file, "utf8"));
    expect(obj).toEqual({ baseUrl: "x", apiKey: "sk-1" });
  });
  it("returns undefined for a corrupt file", async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{not json", "utf8");
    expect(await loadStoredKey(file)).toBeUndefined();
  });
});
