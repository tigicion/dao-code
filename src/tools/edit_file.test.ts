import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { editFileTool } from "./edit_file.js";

let root: string;
let abs: string;
function ctx() {
  return { workspaceRoot: root, readFiles: new Set([abs]) };
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "dao-editfile-"));
  abs = path.join(root, "f.txt");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("edit_file tool", () => {
  it("replaces a unique occurrence", async () => {
    await fs.writeFile(abs, "alpha beta gamma", "utf8");
    const out = await editFileTool.handler({ path: "f.txt", old_string: "beta", new_string: "BETA" }, ctx());
    expect(out).toContain("替换 1 处");
    expect(await fs.readFile(abs, "utf8")).toBe("alpha BETA gamma");
  });

  it("并行编辑同一文件:两处改动都不丢失(同路径串行锁)", async () => {
    await fs.writeFile(abs, "A\nB", "utf8");
    const c = ctx();
    // 并发发两个 edit_file 到同一文件(不同 old_string)——串行锁保证都生效、不互相覆盖、不撞临时文件。
    await Promise.all([
      editFileTool.handler({ path: "f.txt", old_string: "A", new_string: "X" }, c),
      editFileTool.handler({ path: "f.txt", old_string: "B", new_string: "Y" }, c),
    ]);
    expect(await fs.readFile(abs, "utf8")).toBe("X\nY");
  });

  it("replaces all occurrences when replace_all is set", async () => {
    await fs.writeFile(abs, "x x x", "utf8");
    const out = await editFileTool.handler(
      { path: "f.txt", old_string: "x", new_string: "y", replace_all: true },
      ctx(),
    );
    expect(out).toContain("替换 3 处");
    expect(await fs.readFile(abs, "utf8")).toBe("y y y");
  });

  it("throws when old_string is not found", async () => {
    await fs.writeFile(abs, "hello", "utf8");
    await expect(
      editFileTool.handler({ path: "f.txt", old_string: "nope", new_string: "x" }, ctx()),
    ).rejects.toThrow(/未找到/);
  });

  it("throws when old_string is not unique and replace_all is off", async () => {
    await fs.writeFile(abs, "x x", "utf8");
    await expect(
      editFileTool.handler({ path: "f.txt", old_string: "x", new_string: "y" }, ctx()),
    ).rejects.toThrow(/不唯一/);
  });

  it("requires the file to have been read", async () => {
    await fs.writeFile(abs, "hello", "utf8");
    await expect(
      editFileTool.handler(
        { path: "f.txt", old_string: "hello", new_string: "hi" },
        { workspaceRoot: root, readFiles: new Set() },
      ),
    ).rejects.toThrow(/先用 read_file/);
  });

  it("treats $ in new_string literally (no replacement-pattern interpretation)", async () => {
    await fs.writeFile(abs, "price PLACEHOLDER end", "utf8");
    const out = await editFileTool.handler(
      { path: "f.txt", old_string: "PLACEHOLDER", new_string: "$100 & $& and $1" },
      ctx(),
    );
    expect(out).toContain("替换 1 处");
    expect(await fs.readFile(abs, "utf8")).toBe("price $100 & $& and $1 end");
  });

  it("declares write capability and required approval", () => {
    expect(editFileTool.capability).toBe("write");
    expect(editFileTool.approval).toBe("required");
    expect(editFileTool.name).toBe("edit_file");
  });
});
