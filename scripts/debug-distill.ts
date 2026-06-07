// 单独调试"会话结束蒸馏":用固定对话跑一次 flash 蒸馏,把模型原始输出、报错、解析候选全打出来。
// 隔离 distill 与 REPL 接线,定位"为什么没产出记忆"。便宜(一次 flash 调用)。
//   跑:  DEEPSEEK_API_KEY=你的key npm run debug:distill
process.env.CODEDS_DEBUG_MEMORY = "1"; // 让 distill 把原始输出/候选数打到 stderr
import { readConfig } from "../src/config/config.js";
import { streamChat } from "../src/client/client.js";
import { distill } from "../src/memory/distill.js";

const cfg = readConfig(process.env);
if (!cfg.apiKey) {
  console.error("需要 DEEPSEEK_API_KEY(export DEEPSEEK_API_KEY=... 后再跑)。");
  process.exit(1);
}

// 复刻 accept:mem 的 run1 对话(陈述用户信息)。
const messages = [
  { role: "user", content: "我在 macOS 上用 pnpm 管理依赖,平时在学习 AI agent 的实现原理。先随便回我一句就行。" },
  { role: "assistant", content: "好的,macOS + pnpm 这个组合挺干净的。AI agent 那块有什么具体想聊的随时说。" },
];

console.error(`[debug] 用模型 deepseek-v4-flash 跑蒸馏…\n`);
try {
  const mems = await distill({
    streamChat,
    config: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey },
    model: "deepseek-v4-flash",
    messages,
    today: "2026-06-07",
  });
  console.log("\n=== distill 返回候选(应至少 1 条 type:user 记 pnpm/macOS/学agent)===");
  console.log(JSON.stringify(mems, null, 2));
  if (mems.length === 0) console.log("\n⚠️ 0 条 —— 看上面 stderr 的『模型原始输出』判断是 flash 没出 JSON 还是被 importance<4 滤掉。");
} catch (e) {
  console.error("\n=== distill 抛错(这就是 accept:mem 里被静默吞掉的原因)===");
  console.error(e);
  console.error("\n→ 若是模型名/参数错(如 flash 不接受 thinking:disabled、或模型不可用),据此调整。");
}
