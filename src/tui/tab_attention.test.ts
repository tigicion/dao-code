import { describe, expect, it, vi } from "vitest";
import { createTabAttention, formatTabTitle } from "./tab_attention.js";

describe("标签页提示", () => {
  it("圆点保持到确认,重复事件不叠加,退出时恢复标题和焦点模式", () => {
    const write = vi.fn();
    const tab = createTabAttention("dao · 项目", { isTTY: true, write }, {});
    expect(write.mock.calls.flat().join("")).toBe("\x1b[22;0t\x1b]0;dao · 项目\x1b\\\x1b[?1004h");
    write.mockClear();
    tab.mark(); tab.mark();
    expect(write.mock.calls).toEqual([["\x1b]0;🟡 dao · 项目\x1b\\"]]);
    tab.clear(); tab.clear();
    expect(write.mock.calls.at(-1)).toEqual(["\x1b]0;dao · 项目\x1b\\"]);
    tab.mark();
    write.mockClear();
    tab.dispose(); tab.dispose(); tab.mark(); tab.clear();
    expect(write.mock.calls.flat().join("")).toBe("\x1b]0;dao · 项目\x1b\\\x1b[?1004l\x1b[23;0t");
  });

  it.each([{ isTTY: false, env: {} }, { isTTY: true, env: { TERM: "dumb" } }])("非交互输出不混入控制序列: %j", ({ isTTY, env }) => {
    const write = vi.fn();
    const tab = createTabAttention("dao", { isTTY, write }, env);
    tab.mark(); tab.clear(); tab.dispose();
    expect(write).not.toHaveBeenCalled();
  });

  it("目录名里的终端控制字符不能注入标题指令", () => {
    const write = vi.fn();
    const tab = createTabAttention("dao\x07\n\x1b\x9c", { isTTY: true, write }, {});
    tab.mark();
    expect(write.mock.calls.at(-1)).toEqual(["\x1b]0;🟡 dao\x1b\\"]);
    tab.dispose();
  });

  it("完成用绿点,待处理用黄点;重命名保留颜色,查看后保留新名称", () => {
    const write = vi.fn();
    const tab = createTabAttention("项目", { isTTY: true, write }, {});
    tab.mark("completed");
    expect(write.mock.calls.at(-1)).toEqual(["\x1b]0;🟢 项目\x1b\\"]);
    tab.setTitle("修复登录 · 项目");
    expect(write.mock.calls.at(-1)).toEqual(["\x1b]0;🟢 修复登录 · 项目\x1b\\"]);
    const count = write.mock.calls.length;
    tab.setTitle("修复登录 · 项目"); tab.mark("completed");
    expect(write).toHaveBeenCalledTimes(count);
    tab.mark();
    expect(write.mock.calls.at(-1)).toEqual(["\x1b]0;🟡 修复登录 · 项目\x1b\\"]);
    tab.setTitle("\x1b\x07手动标题\n项目");
    expect(write.mock.calls.at(-1)).toEqual(["\x1b]0;🟡 手动标题 项目\x1b\\"]);
    tab.clear();
    expect(write.mock.calls.at(-1)).toEqual(["\x1b]0;手动标题 项目\x1b\\"]);
    tab.dispose();
    write.mockClear(); tab.setTitle("退出后");
    expect(write).not.toHaveBeenCalled();
  });

  it("任务在前目录在后,空标题回退目录,超长标题按完整字符截断且压成一行", () => {
    expect(formatTabTitle("/a/dao-code")).toBe("dao-code");
    expect(formatTabTitle("/a/dao-code", "修复登录超时")).toBe("修复登录超时 · dao-code");
    expect(formatTabTitle("/a/dao-code", " \n ")).toBe("dao-code");
    expect(formatTabTitle("/a/dao-code", "dao-code")).toBe("dao-code");
    expect(formatTabTitle("/a/dao-code", "修复\n\t登录\x1b\x07")).toBe("修复 登录 · dao-code");
    expect(formatTabTitle("/a/dao-code", "🟢".repeat(25))).toBe("🟢".repeat(24) + "… · dao-code");
  });
});
