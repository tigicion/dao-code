import { z } from "zod";
import { defineTool } from "./types.js";

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
  capability: "network",
  approval: "suggest",
  schema: z.object({
    url: z.string().url().describe("要抓取的 http(s) URL"),
    max_chars: z.number().int().min(100).optional().describe("最多返回字符数,默认 20000"),
  }),
  handler: async (args, ctx) => {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const res = await fetchImpl(args.url);
    if (!res.ok) throw new Error(`抓取失败 HTTP ${res.status}`);
    const html = await res.text();
    const text = htmlToText(html);
    const max = args.max_chars ?? 20000;
    return text.length > max ? text.slice(0, max) + "\n…(已截断)" : text;
  },
});
