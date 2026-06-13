import type { Session } from "../session/session.js";
import { todoStore } from "../tools/todo_store.js";

export interface CommandResult {
  handled: boolean;
  output?: string;
  exit?: boolean;
  compact?: boolean;
  clearTranscript?: boolean; // /rewind /resume:已改写 session.messages,App 应清空可视 transcript
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
      todoStore.reset();
      return { handled: true, output: "已清空对话(保留系统设定)" };
    case "compact":
      return { handled: true, compact: true };
    case "cost":
      return { handled: true, output: session.usageSummary() };
    case "help":
      return {
        handled: true,
        output: "/init 生成 DAO.md · /context 上下文占用 · /tasks 后台任务 · /mcp MCP 服务器 · /diff 未提交变更 · /doctor 自检 · /review 审查改动 · /security-review 安全审查 · /hooks 钩子 · /agents 子代理类型 · /files 已读文件 · /memory 审核记忆(/memory delete <名> 删除) · /permissions 权限规则 · /resume <id> 载入会话 · /rewind <n> 回退对话 · /branch 分支会话 · /rename 命名会话 · /export 导出对话 · /copy 复制末条回答 · /btw 随手备注 · /login <key> 设置/更换 key · /logout 清除已存 key · /config 配置 · /effort 思考强度 · /status 状态 · /session 会话信息(含 id) · /skills 列出/开关技能 · /plugin 插件 · /simplify 质量清理改动 · /remember <事实> 记记忆 · /debug 诊断会话日志 · /skillify 提炼技能 · /batch <大改> 并行 worktree 子代理 · /loop <间隔> <prompt> 周期重跑 · /mode 权限模式(default/acceptEdits/auto/plan) · /goal <目标> 长任务(带目标直接开跑) · /coordinator 协作编排 · /model 切模型 · /plan 切模式 · /bypass 关闭免审批(yolo 仅 dao --yolo 启动时开) · /dod <命令> 验收命令 · /restore 回退检查点 · /theme 浅深色 · /clear 清空 · /compact 压缩 · /cost 用量 · /cache 缓存审计 · /exit 退出",
      };
    case "exit":
    case "quit":
      return { handled: true, exit: true, output: "再见。" };
    default:
      return { handled: true, output: `未知命令:/${cmd}(/help 看可用命令)` };
  }
}
