import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDotenv, loadDotenv, applyDotenv } from "./env_file.js";

describe("parseDotenv", () => {
  it("parses KEY=VALUE lines", () => {
    expect(parseDotenv("DEEPSEEK_API_KEY=sk-abc\nDEEPSEEK_MODEL=flash")).toEqual({
      DEEPSEEK_API_KEY: "sk-abc",
      DEEPSEEK_MODEL: "flash",
    });
  });
  it("skips blanks and # comments, strips quotes", () => {
    expect(parseDotenv('\n# comment\nA="quoted"\nB=\'q2\'\n')).toEqual({ A: "quoted", B: "q2" });
  });
  it("ignores lines without =", () => {
    expect(parseDotenv("nonsense\nA=1")).toEqual({ A: "1" });
  });
});

describe("loadDotenv", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "dao-dotenv-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns {} when the file is missing", async () => {
    expect(await loadDotenv(path.join(dir, ".env"))).toEqual({});
  });
  it("loads an existing .env", async () => {
    const f = path.join(dir, ".env");
    await fs.writeFile(f, "DEEPSEEK_API_KEY=sk-xyz\n", "utf8");
    expect(await loadDotenv(f)).toEqual({ DEEPSEEK_API_KEY: "sk-xyz" });
  });
});

describe("applyDotenv", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "dao-dotenv-apply-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    delete process.env.DAO_ENVTEST_NEW;
    delete process.env.DAO_ENVTEST_EXIST;
  });

  it("补进未设置的键,但不覆盖已在 env 中的键(真实 env 优先)", async () => {
    const f = path.join(dir, ".env");
    await fs.writeFile(f, "DAO_ENVTEST_NEW=fromfile\nDAO_ENVTEST_EXIST=fromfile\n", "utf8");
    delete process.env.DAO_ENVTEST_NEW;
    process.env.DAO_ENVTEST_EXIST = "fromenv";
    const applied = await applyDotenv(f);
    expect(process.env.DAO_ENVTEST_NEW).toBe("fromfile");
    expect(process.env.DAO_ENVTEST_EXIST).toBe("fromenv"); // 不覆盖
    expect(applied).toEqual(["DAO_ENVTEST_NEW"]);
  });

  it("文件缺失返回 []、不抛", async () => {
    expect(await applyDotenv(path.join(dir, "nope.env"))).toEqual([]);
  });
});
