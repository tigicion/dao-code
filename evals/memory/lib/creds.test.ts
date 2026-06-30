import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEvalConfig } from "./creds.js";

describe("loadEvalConfig", () => {
  it("config.json 无生效 profile → 抛含『login』提示的错误", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-creds-"));
    const keyFile = path.join(dir, "config.json");
    await fs.writeFile(keyFile, JSON.stringify({ version: 2, activeProfile: "none", profiles: {} }), "utf8");
    await expect(loadEvalConfig({ keyFile })).rejects.toThrow(/login/i);
  });
});
