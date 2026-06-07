// 灰区去重裁判:用 flash 判两条记忆是否在陈述同一件事(可合并)。字符相似度抓不住改写式近重复
//(如"用户在 macOS 用 pnpm" vs "用户用 pnpm 作包管理器"),故灰区交给模型。
// 仅在 upsert 灰区被调用(每候选至多 1 次,蒸馏路径);失败默认 no(保留两条,安全)。
import type { Memory } from "./types.js";

export function makeFlashAdjudicator(
  streamChat: (opts: any) => AsyncGenerator<any, any>,
  config: { baseUrl: string; apiKey: string },
  model = "deepseek-v4-flash",
): (a: Memory, b: Memory) => Promise<boolean> {
  return async (a, b) => {
    try {
      const gen = streamChat({
        baseUrl: config.baseUrl, apiKey: config.apiKey, model,
        messages: [
          { role: "system", content: "判断两条记忆是否在陈述同一件事(可合并为一条)。只输出 yes 或 no,别的都不要。" },
          { role: "user", content: `A: ${a.text}\nB: ${b.text}` },
        ],
        extra: { thinking: { type: "disabled" }, temperature: 0 },
      });
      let out = ""; let r = await gen.next();
      while (!r.done) { if (r.value?.kind === "content") out += r.value.text; r = await gen.next(); }
      if (!out && typeof r.value?.content === "string") out = r.value.content;
      return /\byes\b/i.test(out.trim());
    } catch {
      return false; // 失败默认不合并
    }
  };
}
