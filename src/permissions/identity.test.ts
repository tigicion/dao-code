import { describe, it, expect } from "vitest";
import { toCcIdentity, rememberRule } from "./identity.js";

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
  it("Bash 复合/heredoc/超长 → 不生成规则(只放行本次,防垃圾规则)", () => {
    expect(rememberRule("Bash", '{"command":"cat a | grep b"}')).toBeNull();
    expect(rememberRule("Bash", JSON.stringify({ command: "cat > f << EOF\nx\nEOF" }))).toBeNull();
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
