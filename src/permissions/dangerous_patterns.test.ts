import { describe, it, expect } from "vitest";
import { isDangerousBashPermission } from "./dangerous_patterns.js";

describe("isDangerousBashPermission", () => {
  it("裸 Bash(无 specifier)和 Bash(*) 最危险", () => {
    expect(isDangerousBashPermission(undefined)).toBe(true);
    expect(isDangerousBashPermission("")).toBe(true);
    expect(isDangerousBashPermission("*")).toBe(true);
  });

  it("解释器前缀规则危险", () => {
    expect(isDangerousBashPermission("python:*")).toBe(true);
    expect(isDangerousBashPermission("python3:*")).toBe(true);
    expect(isDangerousBashPermission("node:*")).toBe(true);
    expect(isDangerousBashPermission("ruby:*")).toBe(true);
    expect(isDangerousBashPermission("perl:*")).toBe(true);
    expect(isDangerousBashPermission("tsx:*")).toBe(true);
    expect(isDangerousBashPermission("deno:*")).toBe(true);
  });

  it("包运行器前缀规则危险", () => {
    expect(isDangerousBashPermission("npx:*")).toBe(true);
    expect(isDangerousBashPermission("bunx:*")).toBe(true);
    expect(isDangerousBashPermission("npm run:*")).toBe(true);
    expect(isDangerousBashPermission("yarn run:*")).toBe(true);
    expect(isDangerousBashPermission("pnpm run:*")).toBe(true);
    expect(isDangerousBashPermission("bun run:*")).toBe(true);
  });

  it("shell/提权/动态执行前缀规则危险", () => {
    expect(isDangerousBashPermission("bash:*")).toBe(true);
    expect(isDangerousBashPermission("sh:*")).toBe(true);
    expect(isDangerousBashPermission("zsh:*")).toBe(true);
    expect(isDangerousBashPermission("sudo:*")).toBe(true);
    expect(isDangerousBashPermission("eval:*")).toBe(true);
    expect(isDangerousBashPermission("exec:*")).toBe(true);
    expect(isDangerousBashPermission("env:*")).toBe(true);
    expect(isDangerousBashPermission("xargs:*")).toBe(true);
    expect(isDangerousBashPermission("ssh:*")).toBe(true);
  });

  it("通配变体也危险(python*、python *、python -*)", () => {
    expect(isDangerousBashPermission("python*")).toBe(true);
    expect(isDangerousBashPermission("python *")).toBe(true);
    expect(isDangerousBashPermission("python -*")).toBe(true);
    expect(isDangerousBashPermission("node -c *")).toBe(true);
  });

  it("精确匹配(无通配)也危险", () => {
    expect(isDangerousBashPermission("python")).toBe(true);
    expect(isDangerousBashPermission("sudo")).toBe(true);
    expect(isDangerousBashPermission("node")).toBe(true);
  });

  it("安全规则不危险", () => {
    expect(isDangerousBashPermission("ls:*")).toBe(false);
    expect(isDangerousBashPermission("git status:*")).toBe(false);
    expect(isDangerousBashPermission("npm test:*")).toBe(false);
    expect(isDangerousBashPermission("cat:*")).toBe(false);
    expect(isDangerousBashPermission("echo:*")).toBe(false);
    expect(isDangerousBashPermission("npm run test:*")).toBe(false); // npm run test 不是任意代码执行
  });

  it("大小写不敏感", () => {
    expect(isDangerousBashPermission("Python:*")).toBe(true);
    expect(isDangerousBashPermission("SUDO:*")).toBe(true);
    expect(isDangerousBashPermission("Node:*")).toBe(true);
  });
});
