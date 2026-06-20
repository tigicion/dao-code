import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadProfiles, saveProfiles, addProfile, removeProfile, setActive } from "./profiles_store.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "dao-profiles-"));
  file = path.join(dir, ".dao", "config.json");
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("profiles store", () => {
  it("returns a fresh empty config when the file is missing", async () => {
    const cfg = await loadProfiles(file);
    expect(cfg.version).toBe(2);
    expect(cfg.profiles).toEqual({});
  });

  it("migrates a legacy { apiKey } file on load", async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ apiKey: "sk-legacy", model: "m1" }), "utf8");
    const cfg = await loadProfiles(file);
    expect(cfg.profiles.default!.key).toBe("sk-legacy");
    expect(cfg.profiles.default!.model).toBe("m1");
  });

  it("saves and reloads a v2 config, creating the dir with 0600 perms", async () => {
    const cfg = addProfile(await loadProfiles(file), "work", {
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      key: "sk-work",
    });
    await saveProfiles(file, cfg);
    const reloaded = await loadProfiles(file);
    expect(reloaded.profiles.work!.key).toBe("sk-work");
    expect(reloaded.activeProfile).toBe("work");
    const mode = (await fs.stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("preserves unrelated top-level config fields across save", async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ apiKey: "sk-x", theme: "dark" }), "utf8");
    const cfg = await loadProfiles(file);
    await saveProfiles(file, cfg);
    const obj = JSON.parse(await fs.readFile(file, "utf8"));
    expect(obj.theme).toBe("dark");
    expect(obj.version).toBe(2);
  });
});

describe("profile mutations", () => {
  const base = { version: 2 as const, activeProfile: "default", profiles: {} };

  it("addProfile inserts and makes the new profile active", () => {
    const cfg = addProfile(base, "work", { provider: "deepseek", baseUrl: "b", model: "m", key: "k" });
    expect(cfg.profiles.work!.key).toBe("k");
    expect(cfg.activeProfile).toBe("work");
  });

  it("setActive switches the active profile only if it exists", () => {
    const cfg = addProfile(addProfile(base, "a", { provider: "deepseek", baseUrl: "b", model: "m", key: "1" }), "b", { provider: "deepseek", baseUrl: "b", model: "m", key: "2" });
    expect(setActive(cfg, "a").activeProfile).toBe("a");
    expect(() => setActive(cfg, "missing")).toThrow();
  });

  it("removeProfile drops it and repoints active to a remaining profile", () => {
    let cfg = addProfile(base, "a", { provider: "deepseek", baseUrl: "b", model: "m", key: "1" });
    cfg = addProfile(cfg, "b", { provider: "deepseek", baseUrl: "b", model: "m", key: "2" }); // active=b
    cfg = removeProfile(cfg, "b");
    expect(cfg.profiles.b).toBeUndefined();
    expect(cfg.activeProfile).toBe("a");
  });
});
