import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { semverGt, maybeCheckUpdate } from "./update_check.js";

describe("semverGt", () => {
  it("比较 major.minor.patch", () => {
    expect(semverGt("0.2.0", "0.1.2")).toBe(true);
    expect(semverGt("0.1.3", "0.1.2")).toBe(true);
    expect(semverGt("1.0.0", "0.9.9")).toBe(true);
    expect(semverGt("0.1.2", "0.1.2")).toBe(false);
    expect(semverGt("0.1.1", "0.1.2")).toBe(false);
    expect(semverGt("v0.2.0", "0.1.0")).toBe(true); // 容忍 v 前缀
  });
});

describe("maybeCheckUpdate 节流", () => {
  let home: string, prevHome: string | undefined, prevUrl: string | undefined;
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "dao-upd-"));
    prevHome = process.env.HOME; prevUrl = process.env.DAO_UPDATE_URL;
    process.env.HOME = home;
    process.env.DAO_UPDATE_URL = "http://127.0.0.1:9/nonexistent"; // 故意失败 → 静默,不影响节流写入
  });
  afterEach(async () => {
    process.env.HOME = prevHome;
    if (prevUrl !== undefined) process.env.DAO_UPDATE_URL = prevUrl; else delete process.env.DAO_UPDATE_URL;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("写时间戳;24h 内不再检查(不抛错)", async () => {
    const NOW = 1_900_000_000_000;
    let notices = 0;
    await maybeCheckUpdate(() => notices++, NOW, "0.1.2");
    const stamp = path.join(home, ".dao", ".last-update-check");
    expect(Number(await fs.readFile(stamp, "utf8"))).toBe(NOW); // 已记时间戳
    expect(notices).toBe(0); // 来源失败 → 无提示
  });

  it("DAO_NO_UPDATE_CHECK=1 → 跳过", async () => {
    process.env.DAO_NO_UPDATE_CHECK = "1";
    await maybeCheckUpdate(() => {}, Date.now(), "0.1.2");
    expect(await fs.readFile(path.join(home, ".dao", ".last-update-check"), "utf8").catch(() => "none")).toBe("none");
    delete process.env.DAO_NO_UPDATE_CHECK;
  });
});
