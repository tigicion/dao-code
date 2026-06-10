import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spillOutput } from "./spill.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "dao-spill-"));
});

describe("spillOutput", () => {
  it("小输出原样返回,不落盘", () => {
    expect(spillOutput("hi", root, 100)).toBe("hi");
    expect(existsSync(path.join(root, ".dao", "spill"))).toBe(false);
  });

  it("大输出:截断 + 指针,全量落盘且可读回", () => {
    const full = "X".repeat(300) + "TAILMARK";
    const out = spillOutput(full, root, 100);
    expect(out.length).toBeLessThan(full.length);
    expect(out).toContain("已落盘");
    expect(out).toContain(".dao/spill/");
    const dir = path.join(root, ".dao", "spill");
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(readFileSync(path.join(dir, files[0]!), "utf8")).toBe(full); // 落盘的是全量
  });
});
