import type { Session } from "../session/session.js";
import type { Provider } from "../config/profiles.js";
import { MODELS_BY_PROVIDER } from "../config/profiles.js";
import { todoStore } from "../tools/todo_store.js";
import { switchLang, getLang, type Lang } from "../i18n/i18n.js";

export interface CommandResult {
  handled: boolean;
  output?: string;
  exit?: boolean;
  compact?: boolean;
  clearTranscript?: boolean; // /rewind /resume:已改写 session.messages,App 应清空可视 transcript
}

/** 命令名只允许 [a-zA-Z0-9:_-]；含 / . 等字符的（如文件路径）不是命令。参考 CC looksLikeCommand。 */
function looksLikeCommand(name: string): boolean {
  return /^[a-zA-Z0-9:_-]+$/.test(name);
}

export function dispatchCommand(input: string, session: Session, provider: Provider = "deepseek"): CommandResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { handled: false };
  const parts = trimmed.slice(1).split(/\s+/);
  const cmd = parts[0] ?? "";
  // 防御：命令名含 / . 等非法字符（如 /Users/xxx/a.png）-> 不是命令，当普通文本。
  if (!looksLikeCommand(cmd)) return { handled: false };
  const arg = parts.slice(1).join(" ");

  switch (cmd) {
    case "model": {
      const known = MODELS_BY_PROVIDER[provider] ?? MODELS_BY_PROVIDER.deepseek;
      if (arg) {
        if (!known.includes(arg)) {
          return { handled: true, output: `✗ ${provider} 下未知模型「${arg}」,可选:${known.join(" / ")}` };
        }
        session.setModel(arg);
        return { handled: true, output: `已切换模型:${arg}` };
      }
      const idx = known.indexOf(session.model);
      const next = known[(idx + 1) % known.length] ?? known[0]!;
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
    // TODO(跨会话 usage 聚合,先不做):现 /cost 只给【本会话】token+¥+命中率。跨会话趋势(按天/周花销、
    //   token 趋势、哪个会话/模型最贵)未做;数据已在各会话 cache.jsonl 里,可加个 `dao usage` 脚本聚合,非核心。
    case "cost":
      return { handled: true, output: session.usageSummary() };
    case "lang": {
      // /lang [zh|en]:无参在 zh/en 间切换;带参校验后切换。立即生效并持久化到 settings.json。
      const raw = arg === "zh" || arg === "en" ? arg : (arg ? "" : getLang() === "zh" ? "en" : "zh");
      if (raw !== "zh" && raw !== "en") {
        return { handled: true, output: `✗ 无效语言「${arg}」,可选:zh / en` };
      }
      const next: Lang = raw;
      void switchLang(next);
      return { handled: true, output: next === "zh" ? "已切换语言:中文(已保存,重启后仍生效)" : "Language switched: English (saved, persists after restart)" };
    }
    case "help":
      return {
        handled: true,
        output: "/init 生成 DAO.md · /context 上下文占用 · /tasks 后台任务 · /mcp MCP 服务器 · /diff 未提交变更 · /doctor 自检 · /review 审查改动 · /security-review 安全审查 · /hooks 钩子 · /agents 子代理类型 · /files 已读文件 · /memory 审核记忆(/memory delete <名> 删除) · /permissions 权限规则 · /resume <id> 载入会话 · /rewind <n> 回退对话 · /branch 分支会话 · /rename 命名会话 · /export 导出对话 · /copy 复制末条回答 · /btw 随手备注 · /account 管理账户(增/删/切换,无参弹选择器;/account add <key> [provider] [name]) · /config 配置 · /effort 思考强度 · /status 状态 · /session 会话信息(含 id) · /skills 列出/开关技能 · /plugin 插件 · /simplify 质量清理改动 · /remember <事实> 记记忆 · /debug-session 诊断 dao 自身日志 · /skillify 提炼技能 · /batch <大改> 并行 worktree 子代理 · /loop <间隔> <prompt> 周期重跑 · /mode 权限模式(智能判定/全权放行互切) · /goal <目标> 长任务(带目标直接开跑,大任务自动分阶段编排) · /model 切模型 · /lang 切中/英文 · /plan 切只读规划模式 · /bypass 全权放行开关 · /dod <命令> 验收命令 · /restore 回退检查点 · /theme 浅深色 · /clear 清空 · /compact 压缩 · /cost 用量 · /audit 审计(memory/reflect/tools/perms/cache/skills) · /exit 退出",
      };
    case "exit":
    case "quit":
      return { handled: true, exit: true, output: "再见。" };
    default:
      return { handled: true, output: `未知命令:/${cmd}(/help 看可用命令)` };
  }
}
