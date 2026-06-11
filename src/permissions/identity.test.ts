import { describe, it, expect } from "vitest";
import { toCcIdentity, rememberRule } from "./identity.js";

describe("toCcIdentity — DAO 工具调用 → CC 工具身份", () => {
  it("exec_shell → Bash(command)", () => {
    expect(toCcIdentity("exec_shell", '{"command":"npm test"}')).toEqual({ ccTool: "Bash", value: "npm test" });
  });
  it("read_file → Read(path)", () => {
    expect(toCcIdentity("read_file", '{"path":"src/a.ts"}')).toEqual({ ccTool: "Read", value: "src/a.ts" });
  });
  it("edit_file → Edit / write_file → Write", () => {
    expect(toCcIdentity("edit_file", '{"path":"src/a.ts"}')).toEqual({ ccTool: "Edit", value: "src/a.ts" });
    expect(toCcIdentity("write_file", '{"path":"out.txt"}')).toEqual({ ccTool: "Write", value: "out.txt" });
  });
  it("list_dir → LS / grep_files → Grep / file_search → Glob", () => {
    expect(toCcIdentity("list_dir", '{"path":"src"}')).toEqual({ ccTool: "LS", value: "src" });
    expect(toCcIdentity("grep_files", '{"pattern":"foo","path":"src"}')).toEqual({ ccTool: "Grep", value: "src" });
    expect(toCcIdentity("file_search", '{"glob":"**/*.ts"}')).toEqual({ ccTool: "Glob", value: "**/*.ts" });
  });
  it("fetch_url → WebFetch(url) / web_search → WebSearch(query)", () => {
    expect(toCcIdentity("fetch_url", '{"url":"https://x.com/a"}')).toEqual({ ccTool: "WebFetch", value: "https://x.com/a" });
    expect(toCcIdentity("web_search", '{"query":"claude"}')).toEqual({ ccTool: "WebSearch", value: "claude" });
  });
  it("MCP 工具 → 工具名本身,value 空", () => {
    expect(toCcIdentity("mcp__github__search", "{}")).toEqual({ ccTool: "mcp__github__search", value: "" });
  });
  it("无 CC 对应的工具 → null(走 DAO 能力默认)", () => {
    expect(toCcIdentity("memory_write", "{}")).toBeNull();
    expect(toCcIdentity("todo_write", "{}")).toBeNull();
    expect(toCcIdentity("agent", "{}")).toBeNull();
  });
  it("参数 JSON 损坏 → 仍映射工具名,value 空", () => {
    expect(toCcIdentity("exec_shell", "{bad json")).toEqual({ ccTool: "Bash", value: "" });
  });
});

describe("rememberRule — '允许并记住' 生成的规则", () => {
  it("Bash → 精确命令规则", () => {
    expect(rememberRule("exec_shell", '{"command":"npm run build"}')).toBe("Bash(npm run build)");
  });
  it("路径工具 → 路径规则", () => {
    expect(rememberRule("edit_file", '{"path":"src/a.ts"}')).toBe("Edit(src/a.ts)");
  });
  it("WebFetch → domain 规则", () => {
    expect(rememberRule("fetch_url", '{"url":"https://api.example.com/x"}')).toBe("WebFetch(domain:api.example.com)");
  });
  it("无值(MCP/WebSearch 空 query)→ 裸工具名", () => {
    expect(rememberRule("mcp__github__search", "{}")).toBe("mcp__github__search");
  });
  it("无 CC 对应 → null", () => {
    expect(rememberRule("memory_write", "{}")).toBeNull();
  });
});
