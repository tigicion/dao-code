import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeSkillAdapter, convertSystemPrompt } from "./convert.js";

const DAO = new Set(["Read", "Edit", "Bash"]);
const catalog = "Read — 读文件\nEdit — 改文件\nBash — 跑命令";

let home: string;
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), "dao-adapt-")); });
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });

describe("convertSystemPrompt 模型档/子代理映射", () => {
  const sys = convertSystemPrompt("Read — 读文件");
  it("把外来模型档映射到 dao 的 flash/pro", () => {
    expect(sys).toContain("deepseek-v4-flash");
    expect(sys).toContain("deepseek-v4-pro");
    expect(sys.toLowerCase()).toMatch(/haiku|sonnet|opus/);
  });
  it("把'换便宜模型/独立上下文'重写成 dao 的 agent 子代理模式", () => {
    expect(sys).toContain("agent");
    expect(sys).toMatch(/独立上下文|子代理/);
  });
  it("原文让主流程换模型的意图,也改写成在子代理里跑(而非主循环换模型)", () => {
    expect(sys).toMatch(/主流程|主循环/);
    expect(sys).toMatch(/子代理|agent/);
    // 不再把'保护前缀缓存'当作这条提示词的卖点(真正的保护是结构不变量,见 skill 工具测试)。
    expect(sys).not.toContain("DAO 的核心优化");
  });
});

describe("makeSkillAdapter", () => {
  it("dao 原生技能:不调 flash,原样返回", async () => {
    let called = 0;
    const adapt = makeSkillAdapter({ daoTools: DAO, catalog, homeDir: home, callFlash: async () => { called++; return "X"; } });
    const body = "先 `Read` 再 `Edit`";
    expect(await adapt(body)).toBe(body);
    expect(called).toBe(0);
  });

  it("外来技能:flash 转换一次,按 hash 缓存,二次命中缓存不再调 flash", async () => {
    let called = 0;
    const adapt = makeSkillAdapter({ daoTools: DAO, catalog, homeDir: home, callFlash: async () => { called++; return "用 Read 读、Bash 跑"; } });
    const foreign = "use the `WebFetch` tool then `MultiEdit`";
    expect(await adapt(foreign)).toBe("用 Read 读、Bash 跑"); // flash 转换后结果
    expect(await adapt(foreign)).toBe("用 Read 读、Bash 跑"); // 第二次走缓存
    expect(called).toBe(1); // 只调了一次
  });

  it("flash 失败:退回原文 + 通用提示(无字典兜底)", async () => {
    const adapt = makeSkillAdapter({ daoTools: DAO, catalog, homeDir: home, callFlash: async () => { throw new Error("offline"); } });
    const out = await adapt("call `WebFetch` tool");
    expect(out).toContain("本平台适配");
    expect(out).toContain("call `WebFetch` tool");
  });
});
