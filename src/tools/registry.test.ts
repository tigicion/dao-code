import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "./registry.js";
import { defineTool } from "./types.js";

function makeEcho() {
  return defineTool({
    name: "echo",
    description: "echoes the text",
    capability: "read",
    approval: "auto",
    schema: z.object({ text: z.string() }),
    handler: async (args) => `echo:${args.text}`,
  });
}

describe("ToolRegistry", () => {
  it("registers and dispatches a tool with validated args", async () => {
    const reg = new ToolRegistry();
    reg.register(makeEcho());
    const out = await reg.dispatch("echo", '{"text":"hi"}', { workspaceRoot: "/tmp" });
    expect(out).toBe("echo:hi");
  });

  it("exposes API tools in registration order with name/description/parameters", () => {
    const reg = new ToolRegistry();
    reg.register(makeEcho());
    const api = reg.toApiTools();
    expect(api).toHaveLength(1);
    expect(api[0]!.type).toBe("function");
    expect(api[0]!.function.name).toBe("echo");
    expect(api[0]!.function.description).toBe("echoes the text");
    expect((api[0]!.function.parameters as any).type).toBe("object");
  });

  it("throws on unknown tool", async () => {
    const reg = new ToolRegistry();
    await expect(reg.dispatch("nope", "{}", { workspaceRoot: "/tmp" })).rejects.toThrow(/unknown tool: nope/);
  });

  it("throws on invalid JSON arguments", async () => {
    const reg = new ToolRegistry();
    reg.register(makeEcho());
    await expect(reg.dispatch("echo", "{not json", { workspaceRoot: "/tmp" })).rejects.toThrow(
      /invalid JSON arguments for echo/,
    );
  });

  it("半截 JSON(单次输出被截断)→ 抢救出已生成内容,报诊断信息 + 拆分建议,不静默执行", async () => {
    // 根因(真实撞见:20260717-143212-b8wt):write_file 的 content 太长,单次输出预算不够,
    // JSON 参数生成到一半被截断(unterminated string)。之前只报一句"invalid JSON arguments",
    // 模型看不出截了多少、截在哪,原地重试同一个必然还是太大的调用。
    const reg = new ToolRegistry();
    reg.register(makeEcho());
    const truncated = '{"text": "这是一段很长的文本,写到一半就断掉了没有收尾';
    await expect(reg.dispatch("echo", truncated, { workspaceRoot: "/tmp" })).rejects.toThrow(
      /invalid JSON arguments for echo.*被截断.*text\(\d+ 字符.*拆成更小的几次调用/s,
    );
  });

  it("真的是格式错乱(不是截断)时,抢救失败仍报原样的简短错误", async () => {
    const reg = new ToolRegistry();
    reg.register(makeEcho());
    await expect(reg.dispatch("echo", "{not json", { workspaceRoot: "/tmp" })).rejects.toThrow(
      "invalid JSON arguments for echo",
    );
  });

  it("throws when args fail schema validation", async () => {
    const reg = new ToolRegistry();
    reg.register(makeEcho());
    await expect(reg.dispatch("echo", '{"text":123}', { workspaceRoot: "/tmp" })).rejects.toThrow();
  });
});

describe("ToolRegistry descriptionEn", () => {
  it("uses descriptionEn when lang=en, falls back to description otherwise", () => {
    const reg = new ToolRegistry();
    reg.register(defineTool({
      name: "t1", description: "中文描述", descriptionEn: "English description",
      capability: "read", approval: "auto", schema: z.object({}), handler: async () => "",
    }));
    reg.register(defineTool({
      name: "t2", description: "只有中文",
      capability: "read", approval: "auto", schema: z.object({}), handler: async () => "",
    }));
    const en = reg.toApiTools(undefined, "en");
    expect(en[0]!.function.description).toBe("English description");
    expect(en[1]!.function.description).toBe("只有中文"); // fallback
    const zh = reg.toApiTools(undefined, "zh");
    expect(zh[0]!.function.description).toBe("中文描述");
    const def = reg.toApiTools();
    expect(def[0]!.function.description).toBe("中文描述"); // default zh
  });

  it("passes predicate and lang together", () => {
    const reg = new ToolRegistry();
    reg.register(defineTool({
      name: "r", description: "读", descriptionEn: "Read",
      capability: "read", approval: "auto", schema: z.object({}), handler: async () => "",
    }));
    reg.register(defineTool({
      name: "w", description: "写", descriptionEn: "Write",
      capability: "write", approval: "required", schema: z.object({}), handler: async () => "",
    }));
    const api = reg.toApiTools((t) => t.capability !== "write", "en");
    expect(api).toHaveLength(1);
    expect(api[0]!.function.description).toBe("Read");
  });
});

const mk = (name: string) =>
  defineTool({ name, description: name, capability: "read", approval: "auto", schema: z.object({}), handler: async () => "" });

describe("ToolRegistry.subsetExcluding", () => {
  it("保留除排除名外的全部工具,维持插入顺序", () => {
    const r = new ToolRegistry();
    ["a", "b", "c", "d"].forEach((n) => r.register(mk(n)));
    const sub = r.subsetExcluding(new Set(["b", "d"]));
    expect(sub.get("a")).toBeDefined();
    expect(sub.get("c")).toBeDefined();
    expect(sub.get("b")).toBeUndefined();
    expect(sub.get("d")).toBeUndefined();
    expect(sub.toApiTools().map((t) => t.function.name)).toEqual(["a", "c"]);
  });
  it("排除空集 → 全保留", () => {
    const r = new ToolRegistry();
    ["a", "b"].forEach((n) => r.register(mk(n)));
    expect(r.subsetExcluding(new Set()).toApiTools()).toHaveLength(2);
  });
});

const mkMcp = (name: string, description: string) =>
  defineTool({ name, description, capability: "network", approval: "suggest", schema: z.object({}), handler: async () => "" });

describe("ToolRegistry MCP 可见性(isMcpVisible/searchAndActivateMcp)", () => {
  it("非 mcp__ 前缀的工具永远可见", () => {
    const r = new ToolRegistry();
    r.register(mk("read_file"));
    expect(r.isMcpVisible("read_file")).toBe(true);
  });

  it("mcp__ 工具默认不可见,搜到并激活后可见", () => {
    const r = new ToolRegistry();
    r.register(mkMcp("mcp__github__create_issue", "在 GitHub 建一个 issue"));
    expect(r.isMcpVisible("mcp__github__create_issue")).toBe(false);
    const out = r.searchAndActivateMcp("issue");
    expect(out).toContain("mcp__github__create_issue");
    expect(out).toContain("已激活");
    expect(r.isMcpVisible("mcp__github__create_issue")).toBe(true);
  });

  it("按描述关键词也能命中(不止工具名)", () => {
    const r = new ToolRegistry();
    r.register(mkMcp("mcp__github__foo", "在 GitHub 建一个 issue"));
    const out = r.searchAndActivateMcp("GitHub");
    expect(out).toContain("mcp__github__foo");
  });

  it("不分大小写", () => {
    const r = new ToolRegistry();
    r.register(mkMcp("mcp__github__create_issue", "desc"));
    expect(r.searchAndActivateMcp("ISSUE")).toContain("mcp__github__create_issue");
  });

  it("查无命中 → 提示,不激活任何东西", () => {
    const r = new ToolRegistry();
    r.register(mkMcp("mcp__github__foo", "desc"));
    const out = r.searchAndActivateMcp("不存在的关键词xyz");
    expect(out).toContain("没有 MCP 工具匹配");
    expect(r.isMcpVisible("mcp__github__foo")).toBe(false);
  });

  it("空查询 → 提示提供关键词", () => {
    const r = new ToolRegistry();
    expect(r.searchAndActivateMcp("  ")).toContain("请提供搜索关键词");
  });
});


const mkDeferred = (name: string, description: string) =>
  defineTool({ name, description, capability: "read", approval: "auto", shouldDefer: true, schema: z.object({ x: z.string() }), handler: async () => "" });

describe("ToolRegistry 延迟加载(shouldDefer)", () => {
  it("deferred 工具初始只发简短描述 + 空 parameters", () => {
    const r = new ToolRegistry();
    r.register(mkDeferred("cron_create", "创建定时任务。支持循环和一次性。"));
    const api = r.toApiTools();
    expect(api).toHaveLength(1);
    expect(api[0]!.function.name).toBe("cron_create");
    expect(api[0]!.function.description).toBe("创建定时任务");
    const params = api[0]!.function.parameters as any;
    expect(params.properties).toEqual({});
  });

  it("非 deferred 工具不受影响", () => {
    const r = new ToolRegistry();
    r.register(mk("read_file"));
    r.register(mkDeferred("cron_create", "创建定时任务。"));
    const api = r.toApiTools();
    expect(api).toHaveLength(2);
    expect(api[0]!.function.name).toBe("read_file");
    expect(api[1]!.function.description).toBe("创建定时任务");
  });

  it("searchAndActivateDeferred 激活后 toApiTools 发完整 schema", () => {
    const r = new ToolRegistry();
    r.register(mkDeferred("cron_create", "创建定时任务。支持循环和一次性。"));
    let api = r.toApiTools();
    expect((api[0]!.function.parameters as any).properties).toEqual({});
    const out = r.searchAndActivateDeferred("cron");
    expect(out).toContain("cron_create");
    expect(out).toContain("已激活");
    api = r.toApiTools();
    expect((api[0]!.function.parameters as any).properties).toHaveProperty("x");
  });

  it("已激活的 deferred 工具不再被搜索到", () => {
    const r = new ToolRegistry();
    r.register(mkDeferred("cron_create", "创建定时任务。"));
    r.searchAndActivateDeferred("cron");
    const out = r.searchAndActivateDeferred("cron");
    expect(out).toContain("没有延迟加载工具匹配");
  });

  it("查无命中 -> 提示", () => {
    const r = new ToolRegistry();
    r.register(mkDeferred("cron_create", "创建定时任务。"));
    const out = r.searchAndActivateDeferred("不存在的xyz");
    expect(out).toContain("没有延迟加载工具匹配");
  });

  it("空查询 -> 提示", () => {
    const r = new ToolRegistry();
    expect(r.searchAndActivateDeferred("")).toContain("请提供搜索关键词");
  });
});