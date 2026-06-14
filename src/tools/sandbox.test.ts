import { describe, it, expect, afterEach } from "vitest";
import { sandboxSpawn, sandboxActive } from "./sandbox.js";

afterEach(() => { delete process.env.DAO_SANDBOX; delete process.env.DAO_SANDBOX_NO_NET; });

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

  it("默认不隔离网络(DAO_SANDBOX_NO_NET 未设)", () => {
    process.env.DAO_SANDBOX = "1";
    const r = sandboxSpawn("ls", "/tmp/work");
    if (r && !("error" in r)) {
      expect(r.args).not.toContain("--unshare-net");
      expect(r.args.join(" ")).not.toMatch(/deny network/);
    }
  });

  it("DAO_SANDBOX_NO_NET=1 → spec 反映网络隔离(按平台)", () => {
    process.env.DAO_SANDBOX = "1";
    process.env.DAO_SANDBOX_NO_NET = "1";
    const r = sandboxSpawn("ls", "/tmp/work");
    expect(r).not.toBeNull();
    if (r && !("error" in r)) {
      if (process.platform === "darwin") {
        // macOS SBPL profile 含 (deny network*);profile 在 -p 后一个参数里。
        expect(r.args.join(" ")).toMatch(/\(deny network\*\)/);
      } else if (process.platform === "linux") {
        expect(r.args).toContain("--unshare-net");
      }
    }
  });
});
