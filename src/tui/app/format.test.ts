import { describe, it, expect } from "vitest";
import { clampLines, parseTodoResult } from "./format.js";

describe("clampLines — ⎿ 输出截断", () => {
  it("不超过上限原样返回", () => {
    expect(clampLines(["a", "b"], 5)).toEqual({ shown: ["a", "b"], hidden: 0 });
  });
  it("超过上限截断并报告隐藏行数", () => {
    expect(clampLines(["a", "b", "c", "d"], 2)).toEqual({ shown: ["a", "b"], hidden: 2 });
  });
  it("max=Infinity(verbose)全显", () => {
    expect(clampLines(["a", "b", "c"], Infinity)).toEqual({ shown: ["a", "b", "c"], hidden: 0 });
  });
});

describe("parseTodoResult — todo_write 结果解析成清单项", () => {
  it("解析图标行成 {status, content}", () => {
    const r = parseTodoResult("☐ 写测试\n▶ 实现功能\n☑ 读代码");
    expect(r).toEqual([
      { status: "pending", content: "写测试" },
      { status: "in_progress", content: "实现功能" },
      { status: "completed", content: "读代码" },
    ]);
  });
  it("清空清单 → 空数组", () => {
    expect(parseTodoResult("(任务清单已清空)")).toEqual([]);
  });
  it("忽略不匹配的行", () => {
    expect(parseTodoResult("随便一句\n☑ 完成项")).toEqual([{ status: "completed", content: "完成项" }]);
  });
});
