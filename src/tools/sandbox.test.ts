import { describe, it, expect, afterEach } from "vitest";
import { sandboxSpawn, sandboxActive } from "./sandbox.js";

afterEach(() => { delete process.env.DAO_SANDBOX; });

describe("sandbox", () => {
  it("未启用 → null(照常 shell 执行)", () => {
    delete process.env.DAO_SANDBOX;
    expect(sandboxActive()).toBe(false);
    expect(sandboxSpawn("ls", "/tmp")).toBeNull();
  });

  it("启用 → 返回 spawn 目标或明确错误(取决于平台/可用性)", () => {
    process.env.DAO_SANDBOX = "1";
    expect(sandboxActive()).toBe(true);
    const r = sandboxSpawn("ls -l", "/tmp/work");
    expect(r).not.toBeNull();
    if (r && "error" in r) {
      expect(typeof r.error).toBe("string"); // 沙箱二进制缺失时给清晰错误,不静默放行
    } else {
      expect(r!.file).toBeTruthy();
      expect(r!.args).toContain("ls -l"); // 命令被裹进 sh -c
      expect(r!.args).toContain("/bin/sh");
    }
  });
});
