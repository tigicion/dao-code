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

  it("期间有编辑(有进展)→ 重复的 build 命令不判卡死(build-fix-rebuild 循环)", () => {
    const d = createStuckDetector(3);
    const build = call("exec_shell", '{"command":"swift build"}');
    const edit = call("edit_file", '{"path":"a.swift"}');
    d.record([build], [{ content: "error: A" }]);
    d.record([edit], []); // 有进展 → 重置命令重复窗口
    d.record([build], [{ content: "error: B" }]);
    d.record([edit], []);
    d.record([build], [{ content: "error: C" }]);
    expect(d.stuck()).toBeNull(); // build 被编辑间隔,不算卡死
  });

  it("反复编辑却撞同一错误 → 仍判卡死(改了但没修对)", () => {
    const d = createStuckDetector(3);
    for (let i = 0; i < 3; i++) {
      d.record([call("edit_file", `{"path":"a","n":${i}}`)], [{ content: "Error: 同一个编译错误" }]);
    }
    expect(d.stuck()).toContain("错误");
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
