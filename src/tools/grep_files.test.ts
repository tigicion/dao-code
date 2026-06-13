import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { grepFilesTool } from "./grep_files.js";

let root: string;
function ctx() {
  return { workspaceRoot: root };
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "dao-grep-"));
  await fs.writeFile(path.join(root, "a.ts"), "const foo = 1;\nconst bar = 2;\n", "utf8");
  await fs.writeFile(path.join(root, "b.md"), "foo appears here\n", "utf8");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("grep_files tool", () => {
  it("returns path:line:content for content mode", async () => {
    const out = await grepFilesTool.handler({ pattern: "foo" }, ctx());
    expect(out).toContain("a.ts:1:const foo = 1;");
    expect(out).toContain("b.md:1:foo appears here");
  });

  it("returns only filenames in files mode", async () => {
    const out = await grepFilesTool.handler({ pattern: "foo", mode: "files" }, ctx());
    expect(out).toContain("a.ts");
    expect(out).toContain("b.md");
    expect(out).not.toContain(":1:");
  });

  it("filters by filename glob", async () => {
    const out = await grepFilesTool.handler({ pattern: "foo", glob: "*.ts" }, ctx());
    expect(out).toContain("a.ts");
    expect(out).not.toContain("b.md");
  });

  it("honors ignore_case", async () => {
    const out = await grepFilesTool.handler({ pattern: "FOO", ignore_case: true }, ctx());
    expect(out).toContain("a.ts:1:");
  });

  it("无匹配时回显搜索范围(pattern + path),便于模型自我纠正", async () => {
    const out = await grepFilesTool.handler({ pattern: "zzz-nope", path: "sub" }, ctx());
    expect(out).toContain("无匹配");
    expect(out).toContain("zzz-nope"); // 回显 pattern
    expect(out).toContain("sub"); // 回显 path
  });

  it("declares read capability and auto approval", () => {
    expect(grepFilesTool.capability).toBe("read");
    expect(grepFilesTool.approval).toBe("auto");
    expect(grepFilesTool.name).toBe("grep_files");
  });
});
