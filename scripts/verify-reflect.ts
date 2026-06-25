// 用固定对话跑一次【真模型】统一反思,验证:真模型能否产出可解析的 {onTrack, advisory, memories}。
// 离线测试全用假模型,这步是第一次上真模型。便宜(一次调用)。
//   跑:DEEPSEEK_API_KEY=... npx tsx scripts/verify-reflect.ts
process.env.DAO_DEBUG_REFLECT = "1";
import { streamChat } from "../src/client/client.js";
import { reflect } from "../src/agent/unified_reflect.js";

const apiKey = process.env.DEEPSEEK_API_KEY ?? "";
const baseUrl = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
const cfg = { apiKey, baseUrl };
if (!cfg.apiKey) { console.error("需要 DEEPSEEK_API_KEY。"); process.exit(1); }

// 场景:既【打转】(反复改 foo.ts:42)又【纠正】(以后用中文)→ 期望 onTrack=false + advisory + feedback 记忆。
const messages = [
  { role: "user", content: "帮我把 foo.ts 的空指针崩溃修了" },
  { role: "assistant", content: "我在 foo.ts:42 加了判空。" },
  { role: "user", content: "还是不行,一模一样的报错。" },
  { role: "assistant", content: "那我再在 foo.ts:42 调整一下判空写法。" },
  { role: "user", content: "不对。还有,以后你回复一律用中文,别夹英文。" },
];
const existing = [{ title: "包管理器", text: "项目用 pnpm 装依赖" }];

console.error("[verify] 用 deepseek-v4-flash 跑一次反思(非 fork)…\n");
try {
  const r = await reflect({
    streamChat, config: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey },
    model: "deepseek-v4-flash", messages, today: "2026-06-25", existing, fork: false,
  });
  console.log("\n=== ReflectResult ===");
  console.log(JSON.stringify(r, null, 2));
  console.log("\n判读:");
  console.log(`  onTrack=${r.onTrack}(期望 false:在打转/被纠正)`);
  console.log(`  advisory=${r.advisory ? "有 ✓" : "无"}`);
  console.log(`  memories=${r.memories.length} 条${r.memories.some((m) => m.type === "feedback") ? "(含 feedback ✓)" : ""}`);
} catch (e) {
  console.error("\n=== 反思抛错 ===");
  console.error(e);
}
