import { describe, it, expect } from "vitest";
import { toCcIdentity, rememberRule } from "./identity.js";
import { parseRule, ruleMatches } from "./rules.js";

describe("toCcIdentity — DAO 工具调用 → CC 工具身份", () => {
  it("Bash → Bash(command)", () => {
    expect(toCcIdentity("Bash", '{"command":"npm test"}')).toEqual({ ccTool: "Bash", value: "npm test" });
  });
  it("Read → Read(path)", () => {
    expect(toCcIdentity("Read", '{"path":"src/a.ts"}')).toEqual({ ccTool: "Read", value: "src/a.ts" });
  });
  it("Edit → Edit / Write → Write", () => {
    expect(toCcIdentity("Edit", '{"path":"src/a.ts"}')).toEqual({ ccTool: "Edit", value: "src/a.ts" });
    expect(toCcIdentity("Write", '{"path":"out.txt"}')).toEqual({ ccTool: "Write", value: "out.txt" });
  });
  it("ListDir → LS / Grep → Grep / Glob → Glob", () => {
    expect(toCcIdentity("ListDir", '{"path":"src"}')).toEqual({ ccTool: "LS", value: "src" });
    expect(toCcIdentity("Grep", '{"pattern":"foo","path":"src"}')).toEqual({ ccTool: "Grep", value: "src" });
    expect(toCcIdentity("Glob", '{"glob":"**/*.ts"}')).toEqual({ ccTool: "Glob", value: "**/*.ts" });
  });
  it("WebFetch → WebFetch(url) / WebSearch → WebSearch(query)", () => {
    expect(toCcIdentity("WebFetch", '{"url":"https://x.com/a"}')).toEqual({ ccTool: "WebFetch", value: "https://x.com/a" });
    expect(toCcIdentity("WebSearch", '{"query":"claude"}')).toEqual({ ccTool: "WebSearch", value: "claude" });
  });
  it("MCP 工具 → 工具名本身,value 空", () => {
    expect(toCcIdentity("mcp__github__search", "{}")).toEqual({ ccTool: "mcp__github__search", value: "" });
  });
  it("无 CC 对应的工具 → null(走 DAO 能力默认)", () => {
    expect(toCcIdentity("MemoryWrite", "{}")).toBeNull();
    expect(toCcIdentity("TodoWrite", "{}")).toBeNull();
    expect(toCcIdentity("Agent", "{}")).toBeNull();
  });
  it("参数 JSON 损坏 → 仍映射工具名,value 空", () => {
    expect(toCcIdentity("Bash", "{bad json")).toEqual({ ccTool: "Bash", value: "" });
  });
});

describe("rememberRule — '允许并记住' 生成的规则", () => {
  it("Bash 简单命令 → 智能前缀规则(同类免再问)", () => {
    expect(rememberRule("Bash", '{"command":"npm run build"}')).toBe("Bash(npm run:*)");
    expect(rememberRule("Bash", '{"command":"ls -la"}')).toBe("Bash(ls:*)");
  });
  it("Bash 复合/heredoc/超长 → 提炼不出通配前缀时,退化成精确匹配当前命令原文(不是不生成规则)", () => {
    // 之前这里直接返回 null——选"总是允许"/"仅本次会话"会静默什么都不保存,同一条命令下次还会
    // 重新问一遍(用户体感就是"反复问同一个问题")。现在退化成精确匹配:下次字节相同的命令直接放行,
    // 内容变了(哪怕只变一点)才会重新走判断——不会把"精确的这一条"错误泛化成危险的通配规则。
    expect(rememberRule("Bash", '{"command":"cat a | grep b"}')).toBe("Bash(cat a | grep b)");
    expect(rememberRule("Bash", JSON.stringify({ command: "cat > f << EOF\nx\nEOF" })))
      .toBe("Bash(cat > f << EOF\nx\nEOF)");
  });
  it("敏感操作整体加白:与普通命令一样走泛化前缀(同类不再问)", () => {
    // 敏感命令选"始终允许"后,记的是泛化前缀规则——rm -rf / 加白后,同类的 rm -rf /tmp 也不再过问。
    // (rm 的 -rf 是 flag,不算子命令,故前缀是 rm;cat 的目标路径非 flag,故前缀含路径)
    expect(rememberRule("Bash", '{"command":"rm -rf /"}')).toBe("Bash(rm:*)");
    expect(rememberRule("Bash", '{"command":"cat ~/.aws/credentials"}')).toBe("Bash(cat ~/.aws/credentials:*)");
    // 匹配语义:前缀规则命中同类命令,不命中不同程序。
    const rule = parseRule(rememberRule("Bash", '{"command":"rm -rf /"}')!);
    expect(ruleMatches(rule, { ccTool: "Bash", value: "rm -rf /" })).toBe(true);
    expect(ruleMatches(rule, { ccTool: "Bash", value: "rm -rf /tmp" })).toBe(true);
    expect(ruleMatches(rule, { ccTool: "Bash", value: "ls" })).toBe(false);
  });
  it("Bash 精确匹配规则:同一条命令原样重复 → 命中;内容变了 → 不命中(不会被泛化成通配)", () => {
    const cmd = "cat > f << EOF\nx\nEOF";
    const rule = rememberRule("Bash", JSON.stringify({ command: cmd }))!;
    const parsed = parseRule(rule);
    expect(ruleMatches(parsed, { ccTool: "Bash", value: cmd })).toBe(true);
    expect(ruleMatches(parsed, { ccTool: "Bash", value: "cat > f << EOF\ny\nEOF" })).toBe(false);
  });
  it("WebSearch → 裸工具名(任何查询都放行,不存具体 query)", () => {
    expect(rememberRule("WebSearch", '{"query":"some specific query"}')).toBe("WebSearch");
  });
  it("路径工具 → 路径规则", () => {
    expect(rememberRule("Edit", '{"path":"src/a.ts"}')).toBe("Edit(src/a.ts)");
  });
  it("WebFetch → domain 规则", () => {
    expect(rememberRule("WebFetch", '{"url":"https://api.example.com/x"}')).toBe("WebFetch(domain:api.example.com)");
  });
  it("无值(MCP/WebSearch 空 query)→ 裸工具名", () => {
    expect(rememberRule("mcp__github__search", "{}")).toBe("mcp__github__search");
  });
  it("无 CC 对应 → null", () => {
    expect(rememberRule("MemoryWrite", "{}")).toBeNull();
  });
});
