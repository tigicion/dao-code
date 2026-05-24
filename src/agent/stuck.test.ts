import { describe, it, expect } from "vitest";
import { createStuckDetector } from "./stuck.js";

const call = (name: string, args = "{}") => ({ name, args });

describe("createStuckDetector", () => {
  it("同一工具调用达阈值(3)→ 判卡死", () => {
    const d = createStuckDetector(3);
    d.record([call("read_file", '{"path":"a"}')], []);
    d.record([call("read_file", '{"path":"a"}')], []);
    expect(d.stuck()).toBeNull();
    d.record([call("read_file", '{"path":"a"}')], []);
    expect(d.stuck()).toContain("重复");
  });

  it("不同调用不判卡死", () => {
    const d = createStuckDetector(3);
    d.record([call("read_file", '{"path":"a"}')], []);
    d.record([call("read_file", '{"path":"b"}')], []);
    d.record([call("list_dir", '{"path":"."}')], []);
    expect(d.stuck()).toBeNull();
  });

  it("同一错误反复出现 → 判卡死", () => {
    const d = createStuckDetector(3);
    for (let i = 0; i < 3; i++) d.record([], [{ content: "Error: 文件不存在 x.ts" }]);
    expect(d.stuck()).toContain("错误");
  });

  it("reset 清窗口", () => {
    const d = createStuckDetector(2);
    d.record([call("x")], []);
    d.record([call("x")], []);
    expect(d.stuck()).not.toBeNull();
    d.reset();
    expect(d.stuck()).toBeNull();
  });
});
