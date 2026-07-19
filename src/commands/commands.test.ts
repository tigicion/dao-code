import { describe, it, expect } from "vitest";
import { dispatchCommand } from "./commands.js";
import { Session } from "../session/session.js";

function sess() {
  return new Session("SYS", "deepseek-v4-pro");
}

describe("dispatchCommand", () => {
  it("treats non-slash input as not a command", () => {
    expect(dispatchCommand("hello", sess()).handled).toBe(false);
  });

  it("/model with no arg toggles pro<->flash", () => {
    const s = sess();
    const r = dispatchCommand("/model", s);
    expect(r.handled).toBe(true);
    expect(s.model).toBe("deepseek-v4-flash");
    dispatchCommand("/model", s);
    expect(s.model).toBe("deepseek-v4-pro");
  });

  it("/model <id> sets the model", () => {
    const s = sess();
    dispatchCommand("/model deepseek-v4-flash", s);
    expect(s.model).toBe("deepseek-v4-flash");
  });

  it("/model 无参在 qianfan 下按 pro→flash→glm-5.2→glm-5.1→kimi→ernie→pro 循环", () => {
    const s = sess(); // 初始 deepseek-v4-pro
    dispatchCommand("/model", s, "qianfan");
    expect(s.model).toBe("deepseek-v4-flash");
    dispatchCommand("/model", s, "qianfan");
    expect(s.model).toBe("glm-5.2");
    dispatchCommand("/model", s, "qianfan");
    expect(s.model).toBe("glm-5.1");
    dispatchCommand("/model", s, "qianfan");
    expect(s.model).toBe("kimi-k2.6");
    dispatchCommand("/model", s, "qianfan");
    expect(s.model).toBe("ernie-5.1");
    dispatchCommand("/model", s, "qianfan");
    expect(s.model).toBe("deepseek-v4-pro");
  });

  it("/model glm-5.2 对 qianfan 合法", () => {
    const s = sess();
    const r = dispatchCommand("/model glm-5.2", s, "qianfan");
    expect(r.handled).toBe(true);
    expect(s.model).toBe("glm-5.2");
  });

  it("/model kimi-k2.6 和 ernie-5.1 对 qianfan 合法", () => {
    const s = sess();
    const r1 = dispatchCommand("/model kimi-k2.6", s, "qianfan");
    expect(r1.handled).toBe(true);
    expect(s.model).toBe("kimi-k2.6");
    const r2 = dispatchCommand("/model ernie-5.1", s, "qianfan");
    expect(r2.handled).toBe(true);
    expect(s.model).toBe("ernie-5.1");
  });

  it("/model glm-5.1 对 qianfan 合法", () => {
    const s = sess();
    const r = dispatchCommand("/model glm-5.1", s, "qianfan");
    expect(r.handled).toBe(true);
    expect(s.model).toBe("glm-5.1");
  });

  it("/model 无参在 volcengine 下按完整 10 档循环回到 pro", () => {
    const s = sess(); // 初始 deepseek-v4-pro
    const order = [
      "deepseek-v4-flash",
      "doubao-seed-2.0-pro",
      "doubao-seed-2.0-lite",
      "doubao-seed-2.0-code",
      "glm-5.2",
      "kimi-k2.6",
      "kimi-k2.7-code",
      "minimax-m2.7",
      "minimax-m3",
      "deepseek-v4-pro",
    ];
    for (const expected of order) {
      dispatchCommand("/model", s, "volcengine");
      expect(s.model).toBe(expected);
    }
  });

  it("/model doubao-seed-2.0-pro 和 minimax-m3 对 volcengine 合法", () => {
    const s = sess();
    const r1 = dispatchCommand("/model doubao-seed-2.0-pro", s, "volcengine");
    expect(r1.handled).toBe(true);
    expect(s.model).toBe("doubao-seed-2.0-pro");
    const r2 = dispatchCommand("/model minimax-m3", s, "volcengine");
    expect(r2.handled).toBe(true);
    expect(s.model).toBe("minimax-m3");
  });

  it("/model doubao-seed-2.0-code 对 deepseek 非法,给出可选列表且不改动当前模型", () => {
    const s = sess();
    const r = dispatchCommand("/model doubao-seed-2.0-code", s, "deepseek");
    expect(s.model).toBe("deepseek-v4-pro");
    expect(r.output).toContain("deepseek-v4-pro");
    expect(r.output).toContain("deepseek-v4-flash");
  });

  it("/model glm-5.2 对 deepseek 非法,给出可选列表且不改动当前模型", () => {
    const s = sess();
    const r = dispatchCommand("/model glm-5.2", s, "deepseek");
    expect(s.model).toBe("deepseek-v4-pro");
    expect(r.output).toContain("deepseek-v4-pro");
    expect(r.output).toContain("deepseek-v4-flash");
  });

  it("省略 provider 参数时按 deepseek 处理(向后兼容)", () => {
    const s = sess();
    dispatchCommand("/model", s);
    expect(s.model).toBe("deepseek-v4-flash");
  });

  it("/plan toggles mode", () => {
    const s = sess();
    dispatchCommand("/plan", s);
    expect(s.mode).toBe("plan");
    dispatchCommand("/plan", s);
    expect(s.mode).toBe("normal");
  });

  it("/clear resets the conversation", () => {
    const s = sess();
    s.addUser("a");
    dispatchCommand("/clear", s);
    expect(s.messages).toHaveLength(1);
  });

  it("/exit signals exit", () => {
    expect(dispatchCommand("/exit", sess()).exit).toBe(true);
  });

  it("/compact signals compaction", () => {
    const r = dispatchCommand("/compact", sess());
    expect(r.handled).toBe(true);
    expect(r.compact).toBe(true);
  });

  it("unknown command is handled with a hint", () => {
    const r = dispatchCommand("/wat", sess());
    expect(r.handled).toBe(true);
    expect(r.output).toContain("未知命令");
  });

  it("绝对路径（含 /）不当命令处理", () => {
    expect(dispatchCommand("/Users/x/Desktop/a.png", sess()).handled).toBe(false);
    expect(dispatchCommand("/usr/bin/node", sess()).handled).toBe(false);
    expect(dispatchCommand("/var/log/syslog", sess()).handled).toBe(false);
  });

  it("含 . 的路径不当命令处理", () => {
    expect(dispatchCommand("/Desktop/a.jpeg", sess()).handled).toBe(false);
  });

  it("合法命令名（含冒号/下划线/连字符）仍正常分发", () => {
    // 冒号、下划线、连字符是合法命令名字符
    const r = dispatchCommand("/wat", sess());
    expect(r.handled).toBe(true);
  });
});
