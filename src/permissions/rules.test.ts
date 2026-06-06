import { describe, it, expect } from "vitest";
import { parseRule, ruleMatches, evaluate, splitBashCommands } from "./rules.js";

describe("parseRule", () => {
  it("裸工具名(无 specifier)", () => {
    expect(parseRule("Bash")).toEqual({ tool: "Bash" });
  });
  it("带 specifier", () => {
    expect(parseRule("Bash(npm run test:*)")).toEqual({ tool: "Bash", specifier: "npm run test:*" });
    expect(parseRule("Edit(src/**)")).toEqual({ tool: "Edit", specifier: "src/**" });
    expect(parseRule("WebFetch(domain:example.com)")).toEqual({ tool: "WebFetch", specifier: "domain:example.com" });
  });
  it("MCP 工具名(无括号)", () => {
    expect(parseRule("mcp__server__tool")).toEqual({ tool: "mcp__server__tool" });
  });
});

describe("ruleMatches — Bash 命令前缀/精确", () => {
  const m = (rule: string, value: string) => ruleMatches(parseRule(rule), { ccTool: "Bash", value });
  it("裸 Bash 匹配任意命令", () => {
    expect(m("Bash", "rm -rf /")).toBe(true);
  });
  it(":* 前缀匹配", () => {
    expect(m("Bash(npm run test:*)", "npm run test")).toBe(true);
    expect(m("Bash(npm run test:*)", "npm run test -- --watch")).toBe(true);
    expect(m("Bash(npm run test:*)", "npm install")).toBe(false);
  });
  it("无 :* 时精确匹配", () => {
    expect(m("Bash(git status)", "git status")).toBe(true);
    expect(m("Bash(git status)", "git status -s")).toBe(false);
  });
  it("工具名不同不匹配", () => {
    expect(ruleMatches(parseRule("Bash"), { ccTool: "Read", value: "x" })).toBe(false);
  });
});

describe("ruleMatches — 路径 gitignore-glob", () => {
  const m = (rule: string, value: string) => ruleMatches(parseRule(rule), { ccTool: "Edit", value });
  it("** 深层匹配", () => {
    expect(m("Edit(src/**)", "src/a/b.ts")).toBe(true);
    expect(m("Edit(src/**)", "lib/x.ts")).toBe(false);
  });
  it("* 单段匹配(任意目录的同名)", () => {
    expect(ruleMatches(parseRule("Read(*.env)"), { ccTool: "Read", value: ".env" })).toBe(true);
    expect(ruleMatches(parseRule("Read(*.env)"), { ccTool: "Read", value: "secret.env" })).toBe(true);
    expect(ruleMatches(parseRule("Read(*.env)"), { ccTool: "Read", value: "config.json" })).toBe(false);
  });
  it("绝对路径 glob", () => {
    expect(ruleMatches(parseRule("Read(//tmp/**)"), { ccTool: "Read", value: "/tmp/x/y" })).toBe(true);
  });
});

describe("ruleMatches — WebFetch domain", () => {
  const m = (value: string) => ruleMatches(parseRule("WebFetch(domain:example.com)"), { ccTool: "WebFetch", value });
  it("精确域名", () => expect(m("https://example.com/page")).toBe(true));
  it("子域名", () => expect(m("https://api.example.com/x")).toBe(true));
  it("其它域名不匹配", () => expect(m("https://evil.com")).toBe(false));
});

describe("evaluate — deny > ask > allow > 未匹配", () => {
  const id = { ccTool: "Bash", value: "rm -rf /" };
  it("deny 命中即拒绝(即使 allow 也命中)", () => {
    expect(evaluate({ allow: ["Bash"], ask: [], deny: ["Bash(rm:*)"] }, id)).toBe("deny");
  });
  it("ask 命中优先于 allow", () => {
    expect(evaluate({ allow: ["Bash"], ask: ["Bash(rm:*)"], deny: [] }, id)).toBe("ask");
  });
  it("仅 allow 命中", () => {
    expect(evaluate({ allow: ["Bash(rm:*)"], ask: [], deny: [] }, id)).toBe("allow");
  });
  it("无规则命中 → null", () => {
    expect(evaluate({ allow: ["Bash(npm:*)"], ask: [], deny: [] }, id)).toBeNull();
  });
});

describe("splitBashCommands — 复合命令拆分", () => {
  it("按 && || ; | 换行 拆分并去空白", () => {
    expect(splitBashCommands("cd /tmp && rm -rf x")).toEqual(["cd /tmp", "rm -rf x"]);
    expect(splitBashCommands("a || b ; c | d")).toEqual(["a", "b", "c", "d"]);
    expect(splitBashCommands("npm test")).toEqual(["npm test"]);
  });
});

describe("evaluate — Bash 复合命令逐段检查(CC 行为)", () => {
  it("任一子命令命中 deny → 整条 deny(绕不过)", () => {
    const id = { ccTool: "Bash", value: "cd /tmp && rm -rf /" };
    expect(evaluate({ allow: ["Bash(cd:*)"], ask: [], deny: ["Bash(rm -rf:*)"] }, id)).toBe("deny");
  });
  it("全部子命令被 allow → allow", () => {
    const id = { ccTool: "Bash", value: "npm i && git status" };
    expect(evaluate({ allow: ["Bash(npm:*)", "Bash(git:*)"], ask: [], deny: [] }, id)).toBe("allow");
  });
  it("有子命令未被 allow 覆盖 → null(不自动放行,落到询问)", () => {
    const id = { ccTool: "Bash", value: "npm run build && rm -rf x" };
    expect(evaluate({ allow: ["Bash(npm run build)"], ask: [], deny: [] }, id)).toBeNull();
  });
  it("任一子命令命中 ask(无 deny)→ ask", () => {
    const id = { ccTool: "Bash", value: "npm i && deploy" };
    expect(evaluate({ allow: ["Bash(npm:*)"], ask: ["Bash(deploy)"], deny: [] }, id)).toBe("ask");
  });
});
