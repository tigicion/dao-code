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

  it("context lines: before/after show surrounding lines with markers", async () => {
    await fs.writeFile(path.join(root, "ctx.ts"), "line0\nline1\nfoo\nline3\nline4\n", "utf8");
    const out = await grepFilesTool.handler({ pattern: "foo", before: 1, after: 1 }, ctx());
    expect(out).toContain("ctx.ts:2:- line1");
    expect(out).toContain("ctx.ts:3:> foo");
    expect(out).toContain("ctx.ts:4:- line3");
  });

  it("context param acts as both before and after", async () => {
    await fs.writeFile(path.join(root, "ctx2.ts"), "a\nb\nfoo\nc\nd\n", "utf8");
    const out = await grepFilesTool.handler({ pattern: "foo", context: 1 }, ctx());
    expect(out).toContain("ctx2.ts:2:- b");
    expect(out).toContain("ctx2.ts:3:> foo");
    expect(out).toContain("ctx2.ts:4:- c");
  });

  it("head_limit caps result count", async () => {
    await fs.writeFile(path.join(root, "multi.ts"), "foo\nfoo\nfoo\nfoo\nfoo\n", "utf8");
    // 删掉 a.ts 和 b.md,只留 multi.ts,避免其他文件匹配干扰
    await fs.unlink(path.join(root, "a.ts"));
    await fs.unlink(path.join(root, "b.md"));
    const out = await grepFilesTool.handler({ pattern: "foo", head_limit: 2 }, ctx());
    const lines = out.split("\n").filter((l) => l.includes("multi.ts:") && !l.includes("截断"));
    expect(lines.length).toBe(2);
    expect(out).toContain("截断");
  });

  it("offset skips first N matches", async () => {
    await fs.writeFile(path.join(root, "skip.ts"), "foo\nfoo\nfoo\n", "utf8");
    await fs.unlink(path.join(root, "a.ts"));
    await fs.unlink(path.join(root, "b.md"));
    const out = await grepFilesTool.handler({ pattern: "foo", offset: 1 }, ctx());
    const lines = out.split("\n").filter((l) => l.includes("skip.ts:") && !l.includes("跳过"));
    expect(lines.length).toBe(2);
    expect(out).toContain("跳过前 1 条");
  });

  it("type filters by file extension", async () => {
    const out = await grepFilesTool.handler({ pattern: "foo", type: "ts" }, ctx());
    expect(out).toContain("a.ts");
    expect(out).not.toContain("b.md");
  });

  it("multiline matches single-line patterns too", async () => {
    await fs.writeFile(path.join(root, "ml.ts"), "const x = {\n  val: 42,\n};\n", "utf8");
    const out = await grepFilesTool.handler({ pattern: "val:\\s*42", multiline: true }, ctx());
    expect(out).toContain("ml.ts:2:");
  });

  it("multiline matches cross-line patterns", async () => {
    await fs.writeFile(path.join(root, "ml2.rs"), "struct Foo {\n    field: u32,\n}\n", "utf8");
    // struct 后面有 Foo,需匹配跨行到 field
    const out = await grepFilesTool.handler({ pattern: "struct Foo \\{[\\s\\S]*?field", multiline: true }, ctx());
    expect(out).toContain("ml2.rs:1:");
  });
});
