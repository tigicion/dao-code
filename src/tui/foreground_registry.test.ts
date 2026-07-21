import { describe, it, expect } from "vitest";
import { createForegroundRegistry } from "./foreground_registry.js";

describe("ForegroundRegistry", () => {
  it("convertAll 触发所有已注册的回调,返回触发数量", () => {
    const reg = createForegroundRegistry();
    let a = 0, b = 0;
    reg.register("id-a", () => { a++; });
    reg.register("id-b", () => { b++; });
    const n = reg.convertAll();
    expect(n).toBe(2);
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it("没有注册任何调用时,convertAll 返回 0、不报错", () => {
    const reg = createForegroundRegistry();
    expect(reg.convertAll()).toBe(0);
  });

  it("unregister 之后该项不再被 convertAll 触发", () => {
    const reg = createForegroundRegistry();
    let called = 0;
    reg.register("id-a", () => { called++; });
    reg.unregister("id-a");
    expect(reg.convertAll()).toBe(0);
    expect(called).toBe(0);
  });

  it("convertAll 之后注册表清空,连续按两次不会对同一批任务重复触发", () => {
    const reg = createForegroundRegistry();
    let called = 0;
    reg.register("id-a", () => { called++; });
    reg.convertAll();
    expect(reg.convertAll()).toBe(0);
    expect(called).toBe(1);
  });

  it("同一个 id 重复 register 会覆盖旧回调,不是叠加两个", () => {
    const reg = createForegroundRegistry();
    const calls: string[] = [];
    reg.register("id-a", () => calls.push("old"));
    reg.register("id-a", () => calls.push("new"));
    reg.convertAll();
    expect(calls).toEqual(["new"]);
  });
});
