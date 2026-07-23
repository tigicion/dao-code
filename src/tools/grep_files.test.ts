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

describe("Grep tool", () => {
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
    expect(grepFilesTool.name).toBe("Grep");
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

  it("超长行截断时显式标注字符数,不静默切断", async () => {
    const longLine = "x".repeat(400) + "foo" + "y".repeat(400);
    await fs.writeFile(path.join(root, "long.ts"), longLine + "\n", "utf8");
    const out = await grepFilesTool.handler({ pattern: "foo", glob: "long.ts" }, ctx());
    expect(out).toContain(`共 ${longLine.length} 字符,已截断`);
    // 截断点之后的内容(含真正的匹配 foo)不应该出现在默认输出里
    expect(out).not.toContain("y".repeat(400));
  });

  it("only_matching 返回精确匹配边界,不受整行 300 字符截断影响", async () => {
    // 模拟 sanitize-git-repo 场景:真实 token 藏在一行几千字符的 JSON diff 字符串里,
    // 200+ 字符之后才出现,普通 Grep 会被 300 字符截断挡住
    const filler = "-".repeat(320); // 非字母数字,确保贪婪匹配不会吃进 filler
    const secret = "hf_REDACTED_TEST_FIXTURE_TOKEN";
    const line = `{"diff": "${filler}${secret}${filler}"}`;
    await fs.writeFile(path.join(root, "big.json"), line + "\n", "utf8");

    const plain = await grepFilesTool.handler({ pattern: "hf_[A-Za-z0-9]{29,}", glob: "big.json" }, ctx());
    expect(plain).not.toContain(secret); // 普通模式:截断挡住了真正的 token

    const precise = await grepFilesTool.handler(
      { pattern: "hf_[A-Za-z0-9]{29,}", glob: "big.json", only_matching: true },
      ctx(),
    );
    expect(precise).toContain(`<<${secret}>>`); // only_matching:精确拿到匹配文本,边界清晰
  });

  it("path 直接指向具体文件(不是目录)时也能正确搜到,不会被静默判成无匹配", async () => {
    // 复刻 sanitize-git-repo 历史上真实撞见的场景:模型把 path 精确指到一个可疑文件本身
    await fs.writeFile(path.join(root, "single.json"), '{"k": "hf_abcdefghijklmnopqrstuvwxyz123456"}\n', "utf8");
    const out = await grepFilesTool.handler({ pattern: "hf_[a-zA-Z0-9]{20,}", path: "single.json" }, ctx());
    expect(out).toContain("single.json:1:");
    expect(out).toContain("hf_abcdefghijklmnopqrstuvwxyz123456");
  });

  it("match_context 在 only_matching 基础上显示匹配前后 N 个字符", async () => {
    await fs.writeFile(path.join(root, "mc.ts"), "prefix_here foo_needle suffix_here\n", "utf8");
    const out = await grepFilesTool.handler(
      { pattern: "foo_needle", glob: "mc.ts", only_matching: true, match_context: 7 },
      ctx(),
    );
    expect(out).toContain("_here <<foo_needle>> suffi");
  });
});
