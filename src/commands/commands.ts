import type { Session } from "../session/session.js";

export interface CommandResult {
  handled: boolean;
  output?: string;
  exit?: boolean;
  compact?: boolean;
}

export function dispatchCommand(input: string, session: Session): CommandResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { handled: false };
  const parts = trimmed.slice(1).split(/\s+/);
  const cmd = parts[0] ?? "";
  const arg = parts.slice(1).join(" ");

  switch (cmd) {
    case "model": {
      if (arg) {
        session.setModel(arg);
        return { handled: true, output: `已切换模型:${arg}` };
      }
      const next = session.model.includes("flash") ? "deepseek-v4-pro" : "deepseek-v4-flash";
      session.setModel(next);
      return { handled: true, output: `已切换模型:${next}` };
    }
    case "plan": {
      const m = session.toggleMode();
      return {
        handled: true,
        output: m === "plan" ? "已进入 plan 模式(只读+提方案)" : "已回到 normal 模式",
      };
    }
    case "clear":
      session.clear();
      return { handled: true, output: "已清空对话(保留系统设定)" };
    case "compact":
      return { handled: true, compact: true };
    case "cost":
    case "cache":
      return { handled: true, output: session.usageSummary() };
    case "help":
      return {
        handled: true,
        output: "/model [id] 切模型 · /plan 切模式 · /theme 切浅深色 · /yolo 自动批准开关 · /clear 清空 · /compact 压缩对话 · /cost 用量与cache命中 · /exit 退出",
      };
    case "exit":
    case "quit":
      return { handled: true, exit: true, output: "再见。" };
    default:
      return { handled: true, output: `未知命令:/${cmd}(/help 看可用命令)` };
  }
}
