import { describe, it, expect } from "vitest";
import { globToRegExp } from "./glob.js";

describe("globToRegExp", () => {
  it("matches a top-level star pattern but not across directories", () => {
    const re = globToRegExp("*.ts");
    expect(re.test("a.ts")).toBe(true);
    expect(re.test("sub/a.ts")).toBe(false);
    expect(re.test("a.js")).toBe(false);
  });

  it("matches ** across directories, including zero", () => {
    const re = globToRegExp("**/*.ts");
    expect(re.test("a.ts")).toBe(true);
    expect(re.test("sub/a.ts")).toBe(true);
    expect(re.test("a/b/c.ts")).toBe(true);
    expect(re.test("a.js")).toBe(false);
  });

  it("matches ? as a single non-slash char", () => {
    const re = globToRegExp("?.ts");
    expect(re.test("a.ts")).toBe(true);
    expect(re.test("ab.ts")).toBe(false);
  });

  it("treats a directory prefix literally", () => {
    const re = globToRegExp("src/*.ts");
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("lib/a.ts")).toBe(false);
  });

  it("escapes regex-special characters in literals", () => {
    const re = globToRegExp("a.b+c.txt");
    expect(re.test("a.b+c.txt")).toBe(true);
    expect(re.test("aXbXc.txt")).toBe(false);
  });
});
