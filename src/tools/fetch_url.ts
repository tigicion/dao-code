import { z } from "zod";
import { defineTool } from "./types.js";
import { blockedUrlReason } from "./ssrf.js";
import { msg } from "./lang.js";

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export const fetchUrlTool = defineTool({
  name: "fetch_url",
  description: "抓取一个网页 URL,返回去掉标签后的纯文本(超长会截断)。",
  descriptionEn: "Fetches a web page URL, returning plain text with HTML tags stripped (truncated if very long).",
  capability: "network",
  approval: "suggest",
  schema: z.object({
    url: z.string().url().describe("要抓取的 http(s) URL"),
    max_chars: z.number().int().min(100).optional().describe("最多返回字符数,默认 20000"),
  }),
  handler: async (args, ctx) => {
    const blocked = blockedUrlReason(args.url); // S5.3 SSRF:拦内网/环回/云元数据端点
    if (blocked) return msg(`Error: 拒绝抓取(${blocked})`, `Error: Fetch denied (${blocked})`);
    const fetchImpl = ctx.fetchImpl ?? fetch;
    // 超时 30s + 尊重 ctx.signal(ESC):坏 URL/慢站不会永久挂死整个回合。
    const signals = [AbortSignal.timeout(30000), ...(ctx.signal ? [ctx.signal] : [])];
    let res: Response;
    try {
      res = await fetchImpl(args.url, { signal: AbortSignal.any(signals) });
    } catch (e) {
      const reason = e instanceof Error && e.name === "TimeoutError" ? "抓取超时(30s)" : e instanceof Error ? e.message : String(e);
      return msg(`Error: 抓取失败(${reason})`, `Error: Fetch failed (${reason})`);
    }
    if (!res.ok) return msg(`Error: 抓取失败 HTTP ${res.status}`, `Error: Fetch failed HTTP ${res.status}`);
    const html = await res.text();
    const text = htmlToText(html);
    const max = args.max_chars ?? 20000;
    return text.length > max ? text.slice(0, max) + "\n…(已截断)" : text;
  },
});
